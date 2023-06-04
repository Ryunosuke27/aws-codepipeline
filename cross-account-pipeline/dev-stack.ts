import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { Stack, CfnOutput } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import {
  STG_ACCOUNT_ID,
  STG_ARTIFACT_ARN,
  STG_CRYPT_KEY_ARN,
} from "./settings";

export class DevStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const repository = new codecommit.Repository(this, "Repository", {
      repositoryName: "pipeline-test",
    });
    new CfnOutput(this, `CodeCommitRepositoryArn`, {
      value: repository.repositoryArn,
    });

    const pipeline = new codepipeline.Pipeline(this, "Pipeline");

    const sourceStage = pipeline.addStage({ stageName: "Source" });

    const sourceArtifact = new codepipeline.Artifact();

    sourceStage.addAction(
      new codepipeline_actions.CodeCommitSourceAction({
        actionName: "Source",
        branch: "main",
        output: sourceArtifact,
        repository: repository,
      })
    );
    const deployRole = new iam.Role(this, "DeployRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
      ],
    });

    const deployBackendAction = new codepipeline_actions.CodeBuildAction({
      actionName: "DeployBackend",
      runOrder: 2,
      input: sourceArtifact,
      project: new codebuild.PipelineProject(this, "BackendBuildProject", {
        projectName: "backend-build-project",
        role: deployRole,
        buildSpec: codebuild.BuildSpec.fromSourceFilename("./buildspec.yml"),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
        },
      }),
    });
    pipeline.addStage({
      stageName: "Deploy",
      actions: [deployBackendAction],
    });

    // 別環境がCodeCommitに接続するためのロール
    if (STG_ARTIFACT_ARN && STG_CRYPT_KEY_ARN) {
      this.createCodeCommitAccessRole(
        STG_ACCOUNT_ID,
        repository.repositoryArn,
        STG_ARTIFACT_ARN,
        STG_CRYPT_KEY_ARN
      );
    }
  }
  /**
   * CodeCommitのアクセスロールを作成する
   * @summary CodeCommitの操作 + 環境アカウント側のS3バケットとKMSキーにアクセスするロールを作成
   */
  private createCodeCommitAccessRole(
    envAccountId: string,
    sourceRepositoryArn: string,
    artifactBucketArn: string,
    artifactCryptKeyArn: string
  ): iam.Role {
    const role = new iam.Role(this, `CodeCommitRole`, {
      roleName: "codecommit-accessrole",
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${envAccountId}:root`),
      inlinePolicies: {
        thing: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "UploadArtifactPolicy",
              actions: ["s3:PutObject", "s3:PutObjectAcl"],
              resources: [`${artifactBucketArn}/*`],
            }),
            new iam.PolicyStatement({
              sid: "KMSAccessPolicy",
              actions: [
                "kms:DescribeKey",
                "kms:GenerateDataKey*",
                "kms:Encrypt",
                "kms:ReEncrypt*",
                "kms:Decrypt",
              ],
              resources: [artifactCryptKeyArn],
            }),
            new iam.PolicyStatement({
              sid: "CodeCommitAccessPolicy",
              actions: [
                "codecommit:GetBranch",
                "codecommit:GetCommit",
                "codecommit:UploadArchive",
                "codecommit:GetUploadArchiveStatus",
                "codecommit:CancelUploadArchive",
                "codecommit:GetRepository",
              ],
              resources: [sourceRepositoryArn],
            }),
          ],
        }),
      },
    });
    new CfnOutput(this, `CodeCommitAccessRoleArn`, {
      value: role.roleArn,
    });

    return role;
  }
}

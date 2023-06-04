import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { Stack, CfnOutput } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import { DEV_ACCOUNT_ID, DEV_CODECOMMIT_ROLE, DEV_REPO_ARN } from "./settings";

export class StgStack extends cdk.Stack {
  private readonly codePipelineRole: iam.Role;
  private readonly codeBuildRole: iam.Role;
  private readonly encryptionKey: kms.Key;
  private readonly artifactBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 開発環境のAssume Role(CodeCommitアクセス用)に共有するアーティファクトを作成
    if (DEV_ACCOUNT_ID) {
      this.codePipelineRole = this.createCodePipelineRole(DEV_ACCOUNT_ID);
      this.codeBuildRole = this.createCodeBuildRole();
      this.encryptionKey = this.createArtifactKey(
        DEV_ACCOUNT_ID,
        this.codePipelineRole,
        this.codeBuildRole
      );
      this.artifactBucket = this.createArtifactBucket(
        DEV_ACCOUNT_ID,
        this.encryptionKey
      );
    }

    // CI/CDの構築
    if (DEV_REPO_ARN && DEV_CODECOMMIT_ROLE) {
      // ソースコードのリポジトリを取得
      const repository = codecommit.Repository.fromRepositoryArn(
        this,
        `SourceRepository`,
        DEV_REPO_ARN
      );
      // CodeCommit用のロールを取得
      const codeCommitRole = iam.Role.fromRoleArn(
        this,
        "CodeCommitRole",
        DEV_CODECOMMIT_ROLE,
        {
          mutable: false,
        }
      );
      const sourceOutput = new codepipeline.Artifact(); // ソースファイルのアウトプット先
      const buildOutput = new codepipeline.Artifact(); // ビルド結果のアウトプット先

      // フロントエンドのソースコード用
      const frontBucket = new s3.Bucket(this, "FrontendBucket", {});

      // CodePipeline
      const pipeline = new codepipeline.Pipeline(this, `FrontCodePipeline`, {
        pipelineName: `FrontCodePipeline`,
        role: this.codePipelineRole,
        artifactBucket: this.artifactBucket,
        crossAccountKeys: true,
        stages: [
          // ソース取得
          {
            stageName: "Source",
            actions: [
              new codepipeline_actions.CodeCommitSourceAction({
                actionName: "CodeCommit",
                repository: repository,
                output: sourceOutput,
                branch: "stg",
                role: codeCommitRole,
              }),
            ],
          },
          // ビルド
          {
            stageName: "Build",
            actions: [
              new codepipeline_actions.CodeBuildAction({
                actionName: "CodeBuild",
                project: new codebuild.PipelineProject(this, `BuildProject`, {
                  environment: {
                    buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
                  },
                  role: this.codeBuildRole,
                  encryptionKey: this.encryptionKey,
                }),
                runOrder: 2,
                input: sourceOutput,
                outputs: [buildOutput],
              }),
            ],
          },
          // デプロイ
          {
            stageName: "Deploy",
            actions: [
              new codepipeline_actions.S3DeployAction({
                actionName: "S3_Deploy",
                bucket: frontBucket,
                input: buildOutput,
              }),
            ],
          },
        ],
      });
    }
  }

  /**
   * CodePipelineのサービスロール作成
   * @param sourceAccountId CodeCommitのリポジトリを所有しているアカウントID
   */
  private createCodePipelineRole(sourceAccountId: string): iam.Role {
    const role = new iam.Role(this, `CodePipelineServiceRole`, {
      roleName: "codepipeline-role",
      assumedBy: new iam.ServicePrincipal("codepipeline.amazonaws.com"),
      inlinePolicies: {
        thing: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "AssumeRolePolicy",
              actions: ["sts:AssumeRole"],
              resources: [`arn:aws:iam::${sourceAccountId}:role/*`],
            }),
            new iam.PolicyStatement({
              sid: "S3Policy",
              actions: [
                "s3:PutObject",
                "s3:GetObject",
                "s3:GetObjectVersion",
                "s3:GetBucketVersioning",
              ],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              sid: "CodeBuildPolicy",
              actions: ["codebuild:BatchGetBuilds", "codebuild:StartBuild"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });
    new CfnOutput(this, "CodePipelineServiceRoleArn", {
      value: role.roleArn,
    });
    return role;
  }

  /**
   * CodeBuildのサービスロール作成
   */
  private createCodeBuildRole(): iam.Role {
    const role = new iam.Role(this, `CodeBuildServiceRole`, {
      roleName: "codebuild-role",
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      inlinePolicies: {
        thing: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "CloudWatchLogsPolicy",
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              resources: [`*`],
            }),
            new iam.PolicyStatement({
              sid: "S3ObjectPolicy",
              actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
              resources: [`*`],
            }),
          ],
        }),
      },
    });
    new CfnOutput(this, "CodeBuildServiceRoleArn", {
      value: role.roleArn,
    });
    return role;
  }

  /**
   * アーティファクト用のKMS Keyを作成
   */
  private createArtifactKey(
    sourceAccountId: string,
    codePipelineServiceRole: iam.Role,
    codeBuildServiceRole: iam.Role
  ) {
    const cryptKey = new kms.Key(this, "CryptKey", {});
    // 環境アカウントからの操作権限
    cryptKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "Enable IAM User Permissions",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`)],
        actions: ["kms:*"],
        resources: ["*"],
      })
    );

    // CI/CDの各ステージ + 親アカウントからの操作権限
    cryptKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "Allow use of the key",
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ArnPrincipal(codePipelineServiceRole.roleArn),
          new iam.ArnPrincipal(codeBuildServiceRole.roleArn),
          new iam.ArnPrincipal(`arn:aws:iam::${sourceAccountId}:root`),
        ],
        actions: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ],
        resources: ["*"],
      })
    );
    cryptKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "Allow attachment of persistent resources",
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ArnPrincipal(codePipelineServiceRole.roleArn),
          new iam.ArnPrincipal(codeBuildServiceRole.roleArn),
          new iam.ArnPrincipal(`arn:aws:iam::${sourceAccountId}:root`),
        ],
        actions: ["kms:CreateGrant", "kms:ListGrants", "kms:RevokeGrant"],
        resources: ["*"],
        conditions: {
          Bool: {
            "kms:GrantIsForAWSResource": true,
          },
        },
      })
    );
    new CfnOutput(this, `ArtifactCryptKeyArn`, {
      value: cryptKey.keyArn,
    });

    return cryptKey;
  }

  /**
   * アーティファクト用のS3バケットを作成
   */
  private createArtifactBucket(sourceAccountId: string, cryptKey: kms.Key) {
    // CodePipelineで使用するアーティファクト用バケットを作成sakusei
    const artifactBucket = new s3.Bucket(this, `BuildArtifactBucket`, {
      bucketName: "codecommit-artifact-kokorozashi",
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: cryptKey,
    });

    artifactBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "DenyUnEncryptedObjectUploads",
        effect: iam.Effect.DENY,
        principals: [new iam.StarPrincipal()],
        actions: ["s3:PutObject"],
        resources: [`arn:aws:s3:::${artifactBucket.bucketName}/*`],
        conditions: {
          StringNotEquals: {
            "s3:x-amz-server-side-encryption": "aws:kms",
          },
        },
      })
    );
    artifactBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "DenyInsecureConnections",
        effect: iam.Effect.DENY,
        principals: [new iam.StarPrincipal()],
        actions: ["s3:*"],
        resources: [`arn:aws:s3:::${artifactBucket.bucketName}/*`],
        conditions: {
          Bool: {
            "aws:SecureTransport": false,
          },
        },
      })
    );
    artifactBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CrossAccountS3GetPutPolicy",
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ArnPrincipal(`arn:aws:iam::${sourceAccountId}:root`),
        ],
        actions: ["s3:Get*", "s3:Put*"],
        resources: [`arn:aws:s3:::${artifactBucket.bucketName}/*`],
      })
    );
    artifactBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CrossAccountS3ListPolicy",
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ArnPrincipal(`arn:aws:iam::${sourceAccountId}:root`),
        ],
        actions: ["s3:ListBucket"],
        resources: [`arn:aws:s3:::${artifactBucket.bucketName}`],
      })
    );
    new CfnOutput(this, `ArtifactBucketArn`, {
      value: artifactBucket.bucketArn,
    });
    return artifactBucket;
  }
}

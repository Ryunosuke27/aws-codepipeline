#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { DevStack } from "../lib/cross-account-pipeline/dev-stack";
import {
  DEV_ACCOUNT_ID,
  STG_ACCOUNT_ID,
} from "../lib/cross-account-pipeline/settings";
import { StgStack } from "../lib/cross-account-pipeline/stg-stack";

const app = new cdk.App();

/**
 * CodeCommit + CodePipeline をクロスアカウントで構築する
 *
 * 参考文献
 * https://nekoniki.com/20220617_aws-cross-account-pipeline
 * */
// ①ステージング環境で開発環境に共有するS3とKMSのARNを事前に作成
// ③ステージング環境でCI/CDを構築
// if (process.env.CDK_DEFAULT_ACCOUNT === STG_ACCOUNT_ID) {
  new StgStack(app, "StgStack", {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
  });
// }
// ②開発環境でCI/CDを構築しつつ、STGがAssumeするためのロールを作成
// if (process.env.CDK_DEFAULT_ACCOUNT === DEV_ACCOUNT_ID) {
  new DevStack(app, "DevStack", {});
// }
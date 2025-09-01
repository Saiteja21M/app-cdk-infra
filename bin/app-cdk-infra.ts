#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppCdkInfraStack } from '../lib/app-cdk-infra-stack';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const app = new cdk.App();
new AppCdkInfraStack(app, 'AppCdkInfraStack', {
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: 'eu-central-1'
  },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});
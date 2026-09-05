import { App } from 'aws-cdk-lib';
import { readFileSync } from 'fs';

export interface StageParameters {
	region: string;
	iot: {
		claimCertificateArn: string;
	}
}
export class ContextParameters {
	systemName: string;
	stage: string;
	version: string;
	stageParameters: StageParameters;

	constructor(app: App) {
		this.systemName = app.node.tryGetContext('systemName');
		this.stage = app.node.tryGetContext('stage');
		this.version = app.node.tryGetContext('version');
		console.log(`systemName: ${this.systemName}`);
		console.log(`stage: ${this.stage}`);
		console.log(`version: ${this.version}`);

		const filePath = __dirname + `/../cdk.${this.stage}.json`;
		this.stageParameters = JSON.parse(readFileSync(filePath).toString()) as StageParameters;
		console.log('StageParameters: ');
		console.log(this.stageParameters);
	}

	public getResourceId = (resourceName: string): string => {
		return this.systemName + '-' + this.stage + '-' + resourceName;
	};
}

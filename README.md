# fleet_provisioning_test

## 手動作業

### Claim証明書発行

AWS CLIを利用してClaim証明書を発行する。

* 以下コマンドを実行
    ```
    aws iot create-keys-and-certificate --set-as-active --certificate-pem-outfile=claim-certificate.pem.crt --public-key-outfile=claim-public.key --private-key-outfile=claim-private.key --region=ap-northeast-1 --profile=<your profile if required.>
    ```
* 取得した証明書と鍵一式を `certs` フォルダ内に保存する
    * 証明書: claim-certificate.pem.crt
    * 秘密鍵: claim-private.key
        * 厳重に管理する
    * 公開鍵: claim-public.key
        * 証明書内にも含まれており、公開鍵を明示的に扱うことはない
* AWS CDK実行によって生成されたテンプレート名を`provisioning.py`に記述する（証明書発行用のトピックで指定する必要がある）
* 取得した証明書のARNを控えておく
    * arn:aws:iot:ap-northeast-1:<account_id>>:cert/<certificate id>

### AWSサーバ証明書取得

* 以下コマンド実行
    ```bash
    curl -o AmazonRootCA1.pem https://www.amazontrust.com/repository/AmazonRootCA1.pem
    ```
* `certs`フォルダ内に保存する

---

## 参考

* [量産デバイスや大量のデバイスに個別の認証情報を発行する方法について](https://aws.amazon.com/jp/blogs/news/manage-credential-with-fleet-provisioning-in-mass-production/)
* [Device provisioning MQTT API](https://docs.aws.amazon.com/iot/latest/developerguide/fleet-provision-api.html)
* [Python で MQTT (Paho)](https://qiita.com/emqx_japan/items/b63c918fe137a6db4b37)

### for Trouble shooting

* [AWS IoT Fleet Provisioning doesn't publish certificate response](https://repost.aws/ja/questions/QU09EItn9DQYKaw_E5Pqb6hA/aws-iot-fleet-provisioning-doesn-t-publish-certificate-response)

* [[AWS CloudFormation][AWS SAM] FleetProvisioningテンプレート定義](https://qiita.com/takmot/items/c43977131fd80311fd83)

---

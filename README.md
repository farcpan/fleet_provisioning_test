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

## 証明書ローテーションのフロー

```
① AWS IoTへ通常接続
   現在の証明書A + 秘密鍵A
        ↓
② IoT Jobsを監視
   notify-next （$aws/things/{thingName}/jobs/notify-next）をSubscribe
   start-next/accepted （$aws/things/{thingName}/jobs/start-next/accepted）をSubscribe（start-nextの結果を取得するため）
        ↓
③ start-next（$aws/things/{thingName}/jobs/start-next）へPublish
   ROTATE_CERTIFICATE Job取得
   QUEUED → IN_PROGRESS
        ↓
④ 新しい秘密鍵Bを生成
        ↓
⑤ 秘密鍵BからCSR Bを生成
        ↓
⑥ CSR Bをクラウドへ送信（専用のトピックをクラウド側で定義する★）
        ↓
⑦ クラウドが証明書Bを発行（Fleet Provisioningのケースとは異なり、明示的に証明書発行・ポリシーアタッチ・証明書Publish処理を実装する）
        ↓
⑧ 証明書Bをデバイスが受信
        ↓
⑨ 証明書B + 秘密鍵Bを保存
   ※証明書Aはまだ消さない
        ↓
⑩ 証明書B + 秘密鍵BでAWS IoTへ再接続
        ↓
⑪ 接続成功
        ↓
⑫ Jobを SUCCEEDED に更新（$aws/things/{thingName}/jobs/{jobId}/update にPublish）
        ↓
⑬ クラウド側で証明書AをINACTIVE
    - 専用のトピックを用意し、デバイスから「完了」をPublishさせる
        - ex.) mqtt/dev/{thingName}/certificate/rotation/complete
            ```
            {
                "jobId": "cert-rotate-f1cf...",
                "oldCertificateId": "f1cf53...",
                "newCertificateId": "abcdef..."
            }
            ```
    - Lambdaがこのトピックを受け取り、ThingNameのチェックと証明書が正しいものかをチェックする
        - ListThingPrincipalsV2を呼び、そのThingに現在紐づいているPrincipal一覧の中に newCertificateId の証明書ARNが存在するか確認する
        - MQTT通信の principal() を取得することで、対応する証明書が取得可能（principal = 証明書IDとなるため）
    - チェック後に、対象証明書（oldCertificateIdが示す証明書）をINACTIVEに移行する
```

---

## AppSync Event APIとの接続

将来的にはCognito認証を行う。

現状はIAM認証で構築し、AWSマネジメントコンソール上でテストする前提。

* AppSyncのページに移動し、構築したEventAPIを選択
* Pub/Subテストのページに移動し、 Namespace `app` をサブスクライブする
* `device/main.py` を実行し、IoT Core→Lambda→AppSync の処理を実行させる
* サブスクライブしたNamespaceに対して、データが送信されることをマネジメントコンソール上で確認する

---

## 参考

* [量産デバイスや大量のデバイスに個別の認証情報を発行する方法について](https://aws.amazon.com/jp/blogs/news/manage-credential-with-fleet-provisioning-in-mass-production/)
* [Device provisioning MQTT API](https://docs.aws.amazon.com/iot/latest/developerguide/fleet-provision-api.html)
* [Python で MQTT (Paho)](https://qiita.com/emqx_japan/items/b63c918fe137a6db4b37)

### for Trouble shooting

* [AWS IoT Fleet Provisioning doesn't publish certificate response](https://repost.aws/ja/questions/QU09EItn9DQYKaw_E5Pqb6hA/aws-iot-fleet-provisioning-doesn-t-publish-certificate-response)

* [[AWS CloudFormation][AWS SAM] FleetProvisioningテンプレート定義](https://qiita.com/takmot/items/c43977131fd80311fd83)

---

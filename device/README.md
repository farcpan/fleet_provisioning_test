# 仮想デバイス

## installation

```bash
pip install cryptography paho-mqtt
```

---

## Provision

* load_or_create_private_key
    * 秘密鍵未作成なら作成、作成済みなら読み込み処理実行
* create_csr
    * デバイス固有秘密鍵を使ってCSRを生成する
* client.connect
    * MQTT接続開始
* on_connect()
    * MQTT接続成功により呼ばれる
* client.subscribe
    * トピックをサブスクライブする（Provisionに必要なデータをAWS側から受け取る必要がある）
* publish_csr
    * `$aws/certificates/create-from-csr/json` にCSRをPublishし、デバイス証明書の発行を要求する
* on_message()
    * AWS IoT Coreからレスポンスを受信したときに呼ばれる
    * CSR発行成功時は `certificatePem`、`certificateId`、`certificateOwnershipToken` を取得する
* publish_register_thing
    * `certificateOwnershipToken` と `SerialNumber` を使って `RegisterThing` を要求する
        * AWS側で用意したTemplateは、 `SerialNumber`をパラメータとして受け取りThingを登録するように設定されている
* on_message
    * `RegisterThing` 成功レスポンスを受信する
    * 発行されたデバイス証明書をファイルへ保存する
    * Provisioning完了後、Claim証明書でのMQTT接続を切断する

---

## MQTT

---

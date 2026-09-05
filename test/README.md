# 監査テスト手順

## 期限切れが近い証明書を自作して登録

```bash
cd test
openssl genrsa -out test-ca.key 2048
MSYS2_ARG_CONV_EXCL="*" openssl req -x509 -new -key test-ca.key -sha256 -days 365 -subj "/CN=Rotation Test CA" -out test-ca.pem
openssl genrsa -out test-device.key 2048
MSYS2_ARG_CONV_EXCL="*" openssl req -new -key test-device.key -subj "/CN=rotation-test-device" -out test-device.csr
openssl x509 -req -in test-device.csr -CA test-ca.pem -CAkey test-ca.key -CAcreateserial -out test-device.pem -days 7 -sha256
```
* `MSYS2_ARG_CONV_EXCL="*"` 部分はGitBashで実行するときのため。`/CN`をローカルのパスとして変換する挙動を抑制する

## 作成した証明書の確認

```bash
openssl x509 -in test-device.pem -noout -dates
```

---

## テスト用証明書を登録

```bash
aws iot register-certificate-without-ca --certificate-pem file://test-device.pem --status ACTIVE --region ap-northeast-1 --profile <your_profile>
```

---

## テスト用Thing作成

```bash
aws iot create-thing --thing-name MonitorDev_dev_rotationtest --region ap-northeast-1 --profile <your_profile>
```

---

## テスト用Thingに証明書をアタッチ

```bash
aws iot attach-thing-principal --thing-name MonitorDev_dev_rotationtest \
--principal <certificate_arn> \
--thing-principal-type EXCLUSIVE_THING \
--region ap-northeast-1 \
--profile <your_profile>
```

確認コマンド。

```bash
aws iot list-principal-things-v2 \
--principal <certificate_arn> \
--thing-principal-type EXCLUSIVE_THING \
--profile <your_profile>
```

---
---

## On-demand Audit実行

```bash
aws iot start-on-demand-audit-task \
--target-check-names DEVICE_CERTIFICATE_EXPIRING_CHECK \
--region ap-northeast-1 \
--profile <your_profile>
```

タスクIDが返ってくる。

```json
{                                                                                                                                                                                            
    "taskId": "xxxx"
}
```

---

## 返却されたタスクIDで問い合わせ

```bash
aws iot describe-audit-task \
--task-id <task_id> \
--region ap-northeast-1 \
--profile <your_profile>
```

レスポンス内に `"taskStatus": "COMPLETED"`が含まれていればOK。

```json
{                                                                                                                                                                              
    "taskStatus": "COMPLETED",
    "...": "以下省略"
}
```

---

```bash
aws iot list-audit-findings \
--task-id <task_id> \
--check-name DEVICE_CERTIFICATE_EXPIRING_CHECK \
--region ap-northeast-1 \
--profile <your_profile>
```

結果に監査結果（指摘内容）が出力されていればOK。

```json
{
    "findings": [
        {
            "...": "前略",
            "nonCompliantResource": {
                "resourceType": "DEVICE_CERTIFICATE",
                "resourceIdentifier": {
                    "deviceCertificateId": "<device_certificate_id>"
                },
                "additionalInfo": {
                    "EXPIRATION_TIME": "1789188004000"
                }
            },
            "...": "後略",
        }
    ]
}
```

上記でDefenderの挙動については確認OK。

---

## SNSによってトリガーされたLambdaのログ確認

以下のようなログが出力され、`rotation job created` が確認できればOK。

```
INFO Received Device Defender audit notification { recordCount: 1 }
INFO Certificate rotation candidates collected { taskId: '8b4848ec120c0fa03ff369967cc425a9', count: 1 }
INFO	Certificate rotation job created {
  jobId: 'cert-rotate-f1cf53d14677babba75e6b52ce0cee5f63ed24d9cdf37847e254',
  thingName: 'MonitorDev_dev_rotationtest',
  certificateId: 'f1cf53d14677babba75e6b52ce0cee5f63ed24d9cdf37847e254c561f5ebe153',
  checkName: 'DEVICE_CERTIFICATE_EXPIRING_CHECK'
}
```

---

## Job生成を確認

```bash
aws iot list-job-executions-for-thing \
--thing-name MonitorDev_dev_rotationtest \
--region ap-northeast-1 \
--profile <your_profile>
```

---

## スクリプトによるJob取得

テスト用に証明書を作成した際に生成した鍵を使って、実際にPythonスクリプトからIoT Jobを取得する。

* 先に、テスト用の証明書に、デバイス用のポリシーをアタッチする
* スクリプトを実行する
```bash
python test.py
```
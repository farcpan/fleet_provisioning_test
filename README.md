# fleet_provisioning_test

## 手動作業

* 証明書発行（クレーム証明書）
* クレーム証明書用のポリシーを作成し、クレーム証明書にアタッチする
    * 参考: https://docs.aws.amazon.com/ja_jp/iot/latest/developerguide/provision-wo-cert.html#claim-based

```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["iot:Connect"],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": ["iot:Publish","iot:Receive"],
            "Resource": [
                "arn:aws:iot:ap-northeast-1:910136156309:topic/$aws/certificates/create/*",
                "arn:aws:iot:ap-northeast-1:910136156309:topic/$aws/provisioning-templates/es-test-template-1719586233194/provision/*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": "iot:Subscribe",
            "Resource": [
                "arn:aws:iot:ap-northeast-1:910136156309:topicfilter/$aws/certificates/create/*",
                "arn:aws:iot:ap-northeast-1:910136156309:topicfilter/$aws/provisioning-templates/es-test-template-1719586233194/provision/*"
            ]
        }
    ]
}
```

* AWS CDK実行によって生成されたテンプレート名を`provisioning.py`に記述する（証明書発行用のトピックで指定する必要がある）

---

## 注意事項

* テンプレートの差し替えを行った場合、クレーム証明書に紐づくポリシーも修正が必要（テンプレート名を参照しているため）

---

## 参考

* [量産デバイスや大量のデバイスに個別の認証情報を発行する方法について](https://aws.amazon.com/jp/blogs/news/manage-credential-with-fleet-provisioning-in-mass-production/)
* [Device provisioning MQTT API](https://docs.aws.amazon.com/iot/latest/developerguide/fleet-provision-api.html)
* [Python で MQTT (Paho)](https://qiita.com/emqx_japan/items/b63c918fe137a6db4b37)

### for Trouble shooting

* [AWS IoT Fleet Provisioning doesn't publish certificate response](https://repost.aws/ja/questions/QU09EItn9DQYKaw_E5Pqb6hA/aws-iot-fleet-provisioning-doesn-t-publish-certificate-response)

* [[AWS CloudFormation][AWS SAM] FleetProvisioningテンプレート定義](https://qiita.com/takmot/items/c43977131fd80311fd83)

---

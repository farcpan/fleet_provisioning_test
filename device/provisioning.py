import json
import ssl
from paho.mqtt import client as mqtt_client

# serial-number
serial_number = "S0002"

# client_id
client_id = f"FleetProvisioningTest_Thing_{serial_number}"

# template name (created by AWS CDK)
template_name = "fleet-provision-template"

# mqtt
broker = 'a3kyu7otslabj6-ats.iot.ap-northeast-1.amazonaws.com'
port = 8883

# クレーム証明書
claim_cert = "../certs/5e4c1645d913e9b3827df2ddfe056ba13ab52c188fe5d785a163acc97b160395-certificate.pem.crt"
claim_private_key = "../certs/5e4c1645d913e9b3827df2ddfe056ba13ab52c188fe5d785a163acc97b160395-private.pem.key"

# ルート証明書
ca_root_cert = "../certs/AmazonRootCA1.pem"

# 証明書保存先
cert_pem = f"./{client_id}-certificate.pem.crt"
cert_private_key = f"./{client_id}-private.pem.key"

def on_connect(client, userdata, flags, rc, properties):
    if rc == 0:
        print("Connected!")

        # subscribe
        client.subscribe("$aws/certificates/create/json/accepted")
        client.subscribe(f"$aws/provisioning-templates/{template_name}/provision/json/accepted")
        
        # publish
        print("publish to certificates")
        client.publish("$aws/certificates/create/json")
    else:
        print("Failed to connect...")


def on_message(client, userdata, msg):
    from_topic = msg.topic
    print("=" * 80)
    print(f"on_message::::::from {from_topic}")
    print("=" * 80)

    payload = msg.payload.decode()
    print(payload)

    if from_topic == "$aws/certificates/create/json/accepted":
        parsed_payload = json.loads(payload)
        # 証明書
        certificate_id = parsed_payload["certificateId"]
        certificate_pem = parsed_payload["certificatePem"]
        private_key = parsed_payload["privateKey"]
        certificate_ownership_token = parsed_payload["certificateOwnershipToken"]

        # 証明書保存: すべてのプロセスが完了してから保存すべき！ @FIXME
        with open(cert_pem, "w") as f:
            f.write(certificate_pem)
        
        with open(cert_private_key, "w") as f:
            f.write(private_key)

        # publish
        publish_data = {
            "certificateOwnershipToken": certificate_ownership_token,
            "parameters": {
                "SerialNumber": serial_number
            }
        }
        publish_msg_data = json.dumps(publish_data)
        client.publish(f"$aws/provisioning-templates/{template_name}/provision/json", publish_msg_data)
    elif from_topic == f"$aws/provisioning-templates/{template_name}/provision/json/accepted":
        payload = msg.payload
        print(payload)
    else:
        pass


def main():
    # connect
    ## 第2引数で指定したクライアントIDが必須！これを設定しないと証明書がパブリッシュされない
    client = mqtt_client.Client(mqtt_client.CallbackAPIVersion.VERSION2, client_id)
    client.tls_set(
        ca_certs=ca_root_cert,
        certfile=claim_cert,
        keyfile=claim_private_key,
        #tls_version=ssl.PROTOCOL_TLSv1_2
    )

    client.on_connect = on_connect
    client.on_message = on_message

    print("Start to connect...")
    client.connect(broker, port)

    client.loop_forever()
 

if __name__ == '__main__':
    main()

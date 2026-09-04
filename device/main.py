import json
import ssl
from paho.mqtt import client as mqtt_client

# serial-number
serial_number = "S0001"

# client_id
client_id = f"FleetProvisioningTest_Thing_{serial_number}"

# mqtt
broker = 'a3kyu7otslabj6-ats.iot.ap-northeast-1.amazonaws.com'
port = 8883
topic = f"mqtt/{serial_number}/hoge"
#topic = f"hoge/test"

# ルート証明書
ca_root_cert = "../certs/AmazonRootCA1.pem"

# 証明書
cert_pem = f"./{client_id}-certificate.pem.crt"
cert_private_key = f"./{client_id}-private.pem.key"

def on_connect(client, userdata, flags, rc, properties):
    if rc == 0:
        print("Connected!")

        # subscribe
        #client.subscribe(topic)
        
        # publish
        print("publish")
        client.publish(topic, json.dumps({"test": "hoge"}))
    else:
        print("Failed to connect...")


def on_message(client, userdata, msg):
    from_topic = msg.topic
    print("=" * 80)
    print(f"on_message::::::from {from_topic}")
    print("=" * 80)

    payload = msg.payload.decode()
    print(payload)


def main():
    # connect
    ## 第2引数で指定したクライアントIDが必須！これを設定しないと証明書がパブリッシュされない
    #client = mqtt_client.Client(mqtt_client.CallbackAPIVersion.VERSION2, client_id)
    client = mqtt_client.Client(mqtt_client.CallbackAPIVersion.VERSION2)
    print(f"using: {cert_pem}, {cert_private_key}")
    client.tls_set(
        ca_certs=ca_root_cert,
        certfile=cert_pem,
        keyfile=cert_private_key
    )

    client.on_connect = on_connect
    client.on_message = on_message

    print("Start to connect...")
    client.connect(broker, port)

    client.loop_forever()
 

if __name__ == '__main__':
    main()

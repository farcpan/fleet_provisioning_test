import json
from pathlib import Path

from paho.mqtt import client as mqtt_client


# ----------------------------------------------------------------------
# Device settings
# ----------------------------------------------------------------------

# 環境名
stage_name = "dev"

# serial number
serial_number = "S00001"

# Fleet Provisioning Templateで生成されるThingName
thing_name = f"MonitorDev_{stage_name}_{serial_number}"

# DevicePolicyでは
# client/${iot:Connection.Thing.ThingName}
# のみConnectを許可しているため、Client IDは必ずThingNameと一致させる
client_id = thing_name


# ----------------------------------------------------------------------
# MQTT
# ----------------------------------------------------------------------

broker = "a3kyu7otslabj6-ats.iot.ap-northeast-1.amazonaws.com"
port = 8883

# DevicePolicy:
# mqtt/{stageName}/{thingName}/*
#
# の範囲のみPublish/Subscribe可能
topic = f"mqtt/{stage_name}/{thing_name}/hoge"


# ----------------------------------------------------------------------
# Certificates
# ----------------------------------------------------------------------

script_dir = Path(__file__).resolve().parent

# AWS IoT Coreのサーバ証明書検証用
ca_root_cert = script_dir / "../certs/AmazonRootCA1.pem"

# CSR Fleet Provisioningで取得したデバイス固有証明書
cert_pem = script_dir / f"{thing_name}-certificate.pem.crt"

# デバイス内で生成した恒久秘密鍵
cert_private_key = script_dir / f"{thing_name}-private.pem.key"


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print("Connected!")
        print(f"Client ID : {client_id}")
        print(f"Topic     : {topic}")

        payload = {
            "serialNumber": serial_number,
            "test": "hoge",
        }

        print("Publish...")
        client.publish(
            topic,
            json.dumps(payload),
            qos=1,
        )
    else:
        print(f"Failed to connect. reason_code={reason_code}")


def on_publish(client, userdata, mid, reason_code, properties):
    print(f"Published successfully. mid={mid}")

    # 今回は通信確認だけなのでPublish完了後に切断
    client.disconnect()


def on_disconnect(client, userdata, disconnect_flags, reason_code, properties):
    print(f"Disconnected. reason_code={reason_code}")


def main():
    print(f"ThingName   : {thing_name}")
    print(f"Client ID   : {client_id}")
    print(f"Certificate : {cert_pem}")
    print(f"Private Key : {cert_private_key}")
    print(f"Topic       : {topic}")

    if not cert_pem.exists():
        raise FileNotFoundError(
            f"Device certificate not found: {cert_pem}"
        )

    if not cert_private_key.exists():
        raise FileNotFoundError(
            f"Device private key not found: {cert_private_key}"
        )

    client = mqtt_client.Client(
        mqtt_client.CallbackAPIVersion.VERSION2,
        client_id=client_id,
    )

    client.tls_set(
        ca_certs=str(ca_root_cert),
        certfile=str(cert_pem),
        keyfile=str(cert_private_key),
    )

    client.on_connect = on_connect
    client.on_publish = on_publish
    client.on_disconnect = on_disconnect

    print("Start to connect...")

    client.connect(
        broker,
        port,
        keepalive=60,
    )

    client.loop_forever()


if __name__ == "__main__":
    main()
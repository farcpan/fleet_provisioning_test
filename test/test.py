import json
import ssl
import time

import paho.mqtt.client as mqtt


# ============================================================
# 設定
# ============================================================

IOT_ENDPOINT = "a3kyu7otslabj6-ats.iot.ap-northeast-1.amazonaws.com"
THING_NAME = "MonitorDev_dev_rotationtest"  # テスト用のデバイス名は固定

CA_FILE = "../certs/AmazonRootCA1.pem"
CERT_FILE = "./test-device.pem"
KEY_FILE = "./test-device.key"


# ============================================================
# IoT Jobs Topic
# ============================================================

NEXT_GET_TOPIC = (
    f"$aws/things/{THING_NAME}/jobs/$next/get"
)

NEXT_GET_ACCEPTED_TOPIC = (
    f"$aws/things/{THING_NAME}/jobs/$next/get/accepted"
)

NEXT_GET_REJECTED_TOPIC = (
    f"$aws/things/{THING_NAME}/jobs/$next/get/rejected"
)

NOTIFY_NEXT_TOPIC = (
    f"$aws/things/{THING_NAME}/jobs/notify-next"
)


# ============================================================
# MQTT Callback
# ============================================================

def on_connect(client, userdata, flags, reason_code, properties):
    print(f"Connected: reason_code={reason_code}")

    if reason_code != 0:
        return

    # Job取得結果
    client.subscribe(NEXT_GET_ACCEPTED_TOPIC, qos=1)
    client.subscribe(NEXT_GET_REJECTED_TOPIC, qos=1)

    # 新しいJobが追加された場合の通知
    client.subscribe(NOTIFY_NEXT_TOPIC, qos=1)

    print("Subscribed IoT Jobs topics")

    # 現在の次Jobを取得
    request = {
        "includeJobDocument": True,
        "clientToken": "test-client-001",
    }

    print(f"Publish: {NEXT_GET_TOPIC}")

    client.publish(
        NEXT_GET_TOPIC,
        json.dumps(request),
        qos=1,
    )


def on_message(client, userdata, msg):
    payload = msg.payload.decode("utf-8")

    print()
    print("========================================")
    print(f"Topic: {msg.topic}")
    print(f"Payload: {payload}")
    print("========================================")

    if msg.topic == NEXT_GET_ACCEPTED_TOPIC:
        handle_job(payload)

    elif msg.topic == NEXT_GET_REJECTED_TOPIC:
        print("Job request rejected")

    elif msg.topic == NOTIFY_NEXT_TOPIC:
        print("Job changed. Requesting next job...")

        client.publish(
            NEXT_GET_TOPIC,
            json.dumps({
                "includeJobDocument": True,
                "clientToken": "notify-next",
            }),
            qos=1,
        )


def handle_job(payload: str):
    data = json.loads(payload)

    execution = data.get("execution")

    if not execution:
        print("No pending job")
        return

    job_id = execution.get("jobId")
    status = execution.get("status")
    job_document = execution.get("jobDocument")

    print()
    print("Job received!")
    print(f"jobId = {job_id}")
    print(f"status = {status}")
    print(
        "jobDocument =",
        json.dumps(
            job_document,
            indent=2,
            ensure_ascii=False,
        ),
    )

    if (
        job_document
        and job_document.get("operation")
        == "ROTATE_CERTIFICATE"
    ):
        print()
        print("*** ROTATE_CERTIFICATE detected ***")


# ============================================================
# Main
# ============================================================
if __name__ == '__main__':
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=THING_NAME,
    )

    client.on_connect = on_connect
    client.on_message = on_message

    client.tls_set(
        ca_certs=CA_FILE,
        certfile=CERT_FILE,
        keyfile=KEY_FILE,
        tls_version=ssl.PROTOCOL_TLS_CLIENT,
    )

    print(f"Connecting to {IOT_ENDPOINT}:8883 ...")

    client.connect(
        IOT_ENDPOINT,
        port=8883,
        keepalive=60,
    )

    try:
        client.loop_forever()

    except KeyboardInterrupt:
        print("Disconnecting...")
        client.disconnect()

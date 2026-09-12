import json
import threading
from datetime import datetime, timezone
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

# 通常データ送信用Topic
topic = f"mqtt/{stage_name}/{thing_name}/hoge"
# Basic Ingest用のTopic
ruleName = f"test_topic_rule_${stage_name}"
topic_for_basic_ingest = f"$aws/rules/{ruleName}/{topic}"

# 10秒周期でデータ送信
publish_interval_sec = 10

# ----------------------------------------------------------------------
# Named Device Shadow
# ----------------------------------------------------------------------

shadow_name = "config"

shadow_topic_base = (
    f"$aws/things/{thing_name}/shadow/name/{shadow_name}"
)

shadow_get_topic = f"{shadow_topic_base}/get"
shadow_get_accepted_topic = f"{shadow_topic_base}/get/accepted"
shadow_get_rejected_topic = f"{shadow_topic_base}/get/rejected"

shadow_update_topic = f"{shadow_topic_base}/update"
shadow_update_accepted_topic = f"{shadow_topic_base}/update/accepted"
shadow_update_rejected_topic = f"{shadow_topic_base}/update/rejected"
shadow_update_delta_topic = f"{shadow_topic_base}/update/delta"


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


# ----------------------------------------------------------------------
# Runtime state
# ----------------------------------------------------------------------

stop_event = threading.Event()
publish_thread = None

# 仮想デバイスが現在保持している設定値。
# クラウド側のNamed Shadow "config" の desired に変更が入ると、
# この値を変更して reported としてShadowへ返す。
device_config = { "threshold": 20 }

device_config_lock = threading.Lock()


def apply_config_changes(changes: dict):
    """
    Shadowから受信した設定変更を仮想デバイスへ反映する。
    Noneは設定削除として扱う。
    """
    with device_config_lock:
        for key, value in changes.items():
            if value is None:
                device_config.pop(key, None)
            else:
                device_config[key] = value

        current_config = dict(device_config)

    print("Device config updated:")
    print(json.dumps(current_config, ensure_ascii=False, indent=2))


def get_device_config() -> dict:
    with device_config_lock:
        return dict(device_config)


def publish_reported_config(client, config: dict):
    """
    デバイスへ反映済みの設定をreportedとしてShadowへ通知する。
    """
    payload = {
        "state": {
            "reported": config,
        }
    }

    print("Report device config to shadow:")
    print(json.dumps(payload, ensure_ascii=False, indent=2))

    client.publish(
        shadow_update_topic,
        json.dumps(payload),
        qos=1,
    )


def synchronize_from_shadow_document(client, shadow_document: dict):
    """
    /get/accepted で取得した現在のShadowからローカル状態を同期する。

    deltaが存在する場合:
        desiredとreportedの差分をデバイスへ反映し、reportedを更新する。

    deltaが存在しない場合:
        desiredがあればdesiredをローカル状態として採用する。
        desiredがなければreportedを復元値として利用する。
    """
    state = shadow_document.get("state", {})

    delta = state.get("delta") or {}
    desired = state.get("desired") or {}
    reported = state.get("reported") or {}

    if delta:
        print("Shadow delta found on initial sync.")
        apply_config_changes(delta)
        publish_reported_config(client, get_device_config())
        return

    if desired:
        print("No delta. Restore device config from desired state.")
        apply_config_changes(desired)
        publish_reported_config(client, get_device_config())
        return

    if reported:
        print("No desired state. Restore device config from reported state.")
        apply_config_changes(reported)
        return

    print("Shadow has no config state.")


def publish_worker(client):
    """
    MQTT接続中、10秒に1回通常データをPublishする。
    """
    sequence = 0

    while not stop_event.wait(publish_interval_sec):
        if not client.is_connected():
            continue

        sequence += 1

        payload = {
            "serialNumber": serial_number,
            "sequence": sequence,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "test": "hoge",
        }

        print("Publish telemetry:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))

        client.publish(
            #topic,
            topic_for_basic_ingest,
            json.dumps(payload),
            qos=1,
        )


def start_publish_worker(client):
    global publish_thread

    # 再接続時にPublishスレッドが二重起動しないようにする
    if publish_thread is not None and publish_thread.is_alive():
        return

    publish_thread = threading.Thread(
        target=publish_worker,
        args=(client,),
        name="publish-worker",
        daemon=True,
    )
    publish_thread.start()


def subscribe_shadow_topics(client):
    """
    Named Shadow "config" で利用するTopicをSubscribeする。
    """
    topics = [
        (topic, 1), # Publishを確認するためのサブスクライブ
        (shadow_get_accepted_topic, 1),
        (shadow_get_rejected_topic, 1),
        (shadow_update_delta_topic, 1),
        (shadow_update_accepted_topic, 1),
        (shadow_update_rejected_topic, 1),
    ]

    for shadow_topic, qos in topics:
        result, mid = client.subscribe(shadow_topic, qos=qos)
        print(
            f"Subscribe shadow topic: "
            f"topic={shadow_topic}, result={result}, mid={mid}"
        )


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print("Connected!")
        print(f"Client ID   : {client_id}")
        print(f"Topic       : {topic}")
        print(f"Shadow name : {shadow_name}")

        # 先に応答Topic/delta TopicをSubscribeする
        subscribe_shadow_topics(client)

        # 接続断中のconfig変更も取り込めるよう、
        # 現在のNamed Shadowを取得する
        print("Request current device shadow...")
        client.publish(
            shadow_get_topic,
            payload="",
            qos=1,
        )

        # 10秒周期Publish開始
        start_publish_worker(client)

    else:
        print(f"Failed to connect. reason_code={reason_code}")


def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode("utf-8")) if msg.payload else {}
    except json.JSONDecodeError:
        print(f"Invalid JSON received. topic={msg.topic}")
        return

    print(f"Message received: topic={msg.topic}")

    if msg.topic == shadow_update_delta_topic:
        # deltaのstateには、desiredとreportedで異なる項目だけが入る
        changes = payload.get("state", {})

        print("Shadow config delta received:")
        print(json.dumps(changes, ensure_ascii=False, indent=2))

        # 仮想デバイスへ設定反映
        apply_config_changes(changes)

        # 実際に反映した状態をreportedとして返す
        publish_reported_config(
            client,
            get_device_config(),
        )

    elif msg.topic == shadow_get_accepted_topic:
        print("Shadow get accepted.")
        synchronize_from_shadow_document(client, payload)

    elif msg.topic == shadow_get_rejected_topic:
        print("Shadow get rejected:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))

        # Named Shadowがまだ存在しない場合などは、
        # 現在のデバイス状態をreportedとして送信しShadowを作成する
        if payload.get("code") == 404:
            print("Shadow does not exist. Create it with reported state.")
            publish_reported_config(
                client,
                get_device_config(),
            )

    elif msg.topic == shadow_update_accepted_topic:
        print("Shadow update accepted.")

    elif msg.topic == shadow_update_rejected_topic:
        print("Shadow update rejected:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        # Publishへの応答確認
        print("Publish -> Subscribe")
        print(json.dumps(payload, ensure_ascii=False, indent=2))


def on_publish(client, userdata, mid, reason_code, properties):
    print(f"Published successfully. mid={mid}")


def on_disconnect(client, userdata, disconnect_flags, reason_code, properties):
    print(f"Disconnected. reason_code={reason_code}")


def main():
    print(f"ThingName   : {thing_name}")
    print(f"Client ID   : {client_id}")
    print(f"Certificate : {cert_pem}")
    print(f"Private Key : {cert_private_key}")
    print(f"Topic       : {topic}")
    print(f"Shadow Name : {shadow_name}")

    if not ca_root_cert.exists():
        raise FileNotFoundError(
            f"Root CA certificate not found: {ca_root_cert}"
        )

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
    client.on_message = on_message
    client.on_publish = on_publish
    client.on_disconnect = on_disconnect

    print("Start to connect...")

    client.connect(
        broker,
        port,
        keepalive=60,
    )

    try:
        client.loop_forever()
    except KeyboardInterrupt:
        print("Stopping...")
    finally:
        stop_event.set()
        client.disconnect()


if __name__ == "__main__":
    main()

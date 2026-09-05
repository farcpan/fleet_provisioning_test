import json
import os
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from paho.mqtt import client as mqtt_client


# ----------------------------------------------------------------------
# Device / Fleet Provisioning settings
# ----------------------------------------------------------------------

# serial number
serial_number = "S00002"

# deployment stage
stage_name = "dev"

# Current CDK creates ThingName as:
#   MonitorDev_{stageName}_{serialNumber}
thing_name = f"MonitorDev_{stage_name}_{serial_number}"

# The Claim Policy currently permits any MQTT client ID during provisioning.
# Use a unique provisioning client ID so multiple devices do not disconnect
# each other when they share the same Claim Certificate.
client_id = f"provision-{serial_number}"

# Template name created by the current CDK.
template_name = f"fleet-provision-template-{stage_name}"

# MQTT
broker = "a3kyu7otslabj6-ats.iot.ap-northeast-1.amazonaws.com"
port = 8883


# ----------------------------------------------------------------------
# Certificate / key paths
# ----------------------------------------------------------------------

script_dir = Path(__file__).resolve().parent

# Claim Certificate
claim_cert = script_dir / "../certs/claim-certificate.pem.crt"
claim_private_key = script_dir / "../certs/claim-private.key"

# AWS IoT Root CA
ca_root_cert = script_dir / "../certs/AmazonRootCA1.pem"

# Permanent device certificate/private key.
# The private key is generated locally and never sent to AWS.
device_cert_path = script_dir / f"{thing_name}-certificate.pem.crt"
device_private_key_path = script_dir / f"{thing_name}-private.pem.key"


# ----------------------------------------------------------------------
# Fleet Provisioning MQTT topics
# ----------------------------------------------------------------------

csr_request_topic = "$aws/certificates/create-from-csr/json"
csr_accepted_topic = "$aws/certificates/create-from-csr/json/accepted"
csr_rejected_topic = "$aws/certificates/create-from-csr/json/rejected"

provision_request_topic = (
    f"$aws/provisioning-templates/{template_name}/provision/json"
)
provision_accepted_topic = (
    f"$aws/provisioning-templates/{template_name}/provision/json/accepted"
)
provision_rejected_topic = (
    f"$aws/provisioning-templates/{template_name}/provision/json/rejected"
)


def load_or_create_private_key():
    """
    Load the existing permanent private key, or generate a new RSA-2048 key.

    In a real device, this key should ideally be generated and stored in a
    secure element / TPM and should never leave the device.
    """
    if device_private_key_path.exists():
        print(f"Use existing private key: {device_private_key_path}")
        with device_private_key_path.open("rb") as f:
            return serialization.load_pem_private_key(
                f.read(),
                password=None,
            )

    print("Generate permanent device private key...")

    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )

    private_key_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    with device_private_key_path.open("wb") as f:
        f.write(private_key_pem)

    # The sample runs on a normal PC, but keep the private key file as
    # restrictive as possible on POSIX systems.
    try:
        os.chmod(device_private_key_path, 0o600)
    except OSError:
        pass

    print(f"Private key saved: {device_private_key_path}")

    return private_key


def create_csr(private_key) -> str:
    """
    Create a PEM encoded CSR using the permanent device private key.
    """
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(
            x509.Name(
                [
                    x509.NameAttribute(
                        NameOID.COMMON_NAME,
                        thing_name,
                    )
                ]
            )
        )
        .sign(private_key, hashes.SHA256())
    )

    return csr.public_bytes(serialization.Encoding.PEM).decode("utf-8")


def publish_csr(client, csr_pem: str):
    payload = json.dumps(
        {
            "certificateSigningRequest": csr_pem,
        }
    )

    print(f"Publish CSR: {csr_request_topic}")
    result = client.publish(csr_request_topic, payload)

    if result.rc != mqtt_client.MQTT_ERR_SUCCESS:
        raise RuntimeError(
            f"Failed to publish CSR. MQTT result code={result.rc}"
        )


def publish_register_thing(client, certificate_ownership_token: str):
    payload = json.dumps(
        {
            "certificateOwnershipToken": certificate_ownership_token,
            "parameters": {
                "SerialNumber": serial_number,
            },
        }
    )

    print(f"Publish RegisterThing: {provision_request_topic}")
    result = client.publish(provision_request_topic, payload)

    if result.rc != mqtt_client.MQTT_ERR_SUCCESS:
        raise RuntimeError(
            f"Failed to publish RegisterThing. MQTT result code={result.rc}"
        )


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code != 0:
        print(f"Failed to connect. reason_code={reason_code}")
        return

    print("Connected with Claim Certificate.")

    # AWS recommends subscribing to response topics before sending
    # provisioning requests.
    topics = [
        (csr_accepted_topic, 0),
        (csr_rejected_topic, 0),
        (provision_accepted_topic, 0),
        (provision_rejected_topic, 0),
    ]

    result, _ = client.subscribe(topics)

    if result != mqtt_client.MQTT_ERR_SUCCESS:
        raise RuntimeError(
            f"Failed to subscribe provisioning topics. MQTT result code={result}"
        )

    # The SUBSCRIBE packet is sent before this PUBLISH on the same MQTT
    # connection, so the response subscriptions are established first.
    publish_csr(client, userdata["csr_pem"])


def on_message(client, userdata, msg):
    from_topic = msg.topic
    payload_text = msg.payload.decode("utf-8")

    print("=" * 80)
    print(f"Received: {from_topic}")
    print("=" * 80)

    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        print(f"Invalid JSON payload: {payload_text}")
        client.disconnect()
        return

    if from_topic == csr_accepted_topic:
        certificate_id = payload["certificateId"]
        certificate_pem = payload["certificatePem"]
        certificate_ownership_token = payload["certificateOwnershipToken"]

        print("CreateCertificateFromCsr accepted.")
        print(f"certificateId: {certificate_id}")

        # Do not persist the certificate yet.
        # Keep it in memory until RegisterThing succeeds.
        userdata["pending_certificate_pem"] = certificate_pem
        userdata["certificate_id"] = certificate_id

        publish_register_thing(
            client,
            certificate_ownership_token,
        )

    elif from_topic == csr_rejected_topic:
        print("CreateCertificateFromCsr rejected.")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        client.disconnect()

    elif from_topic == provision_accepted_topic:
        thing_name_from_aws = payload.get("thingName")

        print("RegisterThing accepted.")
        print(f"ThingName: {thing_name_from_aws}")

        certificate_pem = userdata.get("pending_certificate_pem")
        if not certificate_pem:
            print("Permanent certificate is missing in local state.")
            client.disconnect()
            return

        # Save the permanent certificate only after RegisterThing succeeds.
        with device_cert_path.open("w", encoding="utf-8") as f:
            f.write(certificate_pem)

        print(f"Certificate saved : {device_cert_path}")
        print(f"Private key saved : {device_private_key_path}")
        print("")
        print("Fleet Provisioning completed successfully.")
        print(
            "For normal MQTT communication, reconnect using the permanent "
            "certificate/private key and use the ThingName as the MQTT client ID."
        )

        client.disconnect()

    elif from_topic == provision_rejected_topic:
        print("RegisterThing rejected.")
        print(json.dumps(payload, ensure_ascii=False, indent=2))

        # The locally generated private key remains on disk.
        # The certificate returned from CreateCertificateFromCsr is not saved.
        client.disconnect()


def main():
    private_key = load_or_create_private_key()
    csr_pem = create_csr(private_key)

    userdata = {
        "csr_pem": csr_pem,
        "pending_certificate_pem": None,
        "certificate_id": None,
    }

    client = mqtt_client.Client(
        mqtt_client.CallbackAPIVersion.VERSION2,
        client_id=client_id,
        userdata=userdata,
    )

    client.tls_set(
        ca_certs=str(ca_root_cert),
        certfile=str(claim_cert),
        keyfile=str(claim_private_key),
    )

    client.on_connect = on_connect
    client.on_message = on_message

    print("Start Fleet Provisioning with CSR...")
    print(f"SerialNumber : {serial_number}")
    print(f"Client ID    : {client_id}")
    print(f"Template     : {template_name}")
    print(f"ThingName    : {thing_name}")
    print("")

    client.connect(broker, port)

    try:
        client.loop_forever()
    except KeyboardInterrupt:
        print("Interrupted.")
        client.disconnect()


if __name__ == "__main__":
    main()

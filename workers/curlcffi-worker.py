import base64
import json
import sys

from curl_cffi import requests


sessions = {}


def clean_unicode(value):
    if isinstance(value, str):
        return "".join("\ufffd" if 0xD800 <= ord(char) <= 0xDFFF else char for char in value)
    if isinstance(value, dict):
        return {clean_unicode(key): clean_unicode(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean_unicode(item) for item in value]
    return value


def get_session(name, impersonate):
    current = sessions.get(name)
    if current and current["impersonate"] == impersonate:
        return current["client"]
    if current:
        current["client"].close()
    client = requests.Session(impersonate=impersonate)
    sessions[name] = {"client": client, "impersonate": impersonate}
    return client


def request_options(item, timeout):
    body = item.get("body")
    if body is not None and item.get("bodyEncoding") == "base64":
        body = base64.b64decode(body)
    return {
        "method": item.get("method", "GET"),
        "url": item["url"],
        "headers": item.get("headers") or {},
        "data": body,
        "timeout": timeout,
        "allow_redirects": item.get("redirect", True),
    }


def handle(message):
    message = clean_unicode(message)
    timeout = max(float(message.get("timeoutMs", 30000)) / 1000, 1)
    client = get_session(str(message.get("session") or "default"), str(message.get("impersonate") or "chrome"))
    for item in message.get("warm") or []:
        try:
            client.request(**request_options(item, timeout))
        except Exception as error:
            raise RuntimeError(f"warm request {item.get('url')!r}: {error}") from error
    try:
        response = client.request(**request_options(message, timeout))
    except Exception as error:
        raise RuntimeError(f"request {message.get('url')!r}: {error}") from error
    return {
        "status": response.status_code,
        "headers": dict(response.headers),
        "body": response.content.decode("utf-8", "replace"),
    }


for line in sys.stdin:
    message = {}
    try:
        message = json.loads(line)
        result = handle(message)
        result["id"] = message.get("id")
    except Exception as error:
        result = {"id": message.get("id") if "message" in locals() else None, "error": str(error)}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")), flush=True)

import base64, json, sys, urllib.request, urllib.error, uuid
BASE="http://localhost:7350"; KEY="defaultkey"
def post(path, body, auth, basic=False, timeout=40):
    req=urllib.request.Request(BASE+path, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type","application/json")
    req.add_header("Authorization", ("Basic "+auth) if basic else ("Bearer "+auth))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
b=base64.b64encode((KEY+":").encode()).decode()
c,body=post("/v2/account/authenticate/device?create=true", {"id":"av-"+uuid.uuid4().hex}, b, True)
tok=json.loads(body)["token"]
c,body=post("/v2/rpc/recorder_asr_open?unwrap=true", {
  "contract_version":"2026-08-27","client_session_id":"av-"+uuid.uuid4().hex,
  "locale":"en_US","audio":{"codec":"pcm16","sample_rate_hz":16000,"channels":1,"frame_ms":20},
  "age_assertion":{"bracket":"at_or_above_threshold","min_age":13,"declared_at":"2026-08-28T00:00:00Z"},
}, tok)
d=json.loads(body)
if "error" in d:
    print("  REFUSED code=%s" % d["error"]["code"])
    print("  reason: %s" % d["error"]["message"][:400])
    sys.exit(0 if d["error"]["code"]=="ENDPOINT_UNAVAILABLE" else 3)
print("  ACCEPTED session_id=%s  <-- claims transcription is available" % d.get("session_id"))
sys.exit(1)

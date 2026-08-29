import base64, json, os, time, urllib.request, urllib.error, uuid
BASE="http://localhost:7350"; KEY="defaultkey"
def post(path, body, auth, basic=False, timeout=60):
    req=urllib.request.Request(BASE+path, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type","application/json")
    req.add_header("Authorization", ("Basic "+auth) if basic else ("Bearer "+auth))
    t=time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read().decode(), time.time()-t
    except urllib.error.HTTPError as e: return e.code, e.read().decode(), time.time()-t
    except Exception as e: return None, "EXC %s" % type(e).__name__, time.time()-t
b=base64.b64encode((KEY+":").encode()).decode()
c,body,_=post("/v2/account/authenticate/device?create=true", {"id":"gcl-"+uuid.uuid4().hex}, b, True)
tok=json.loads(body)["token"]
gc=os.environ["GCTOK"]
print("--- the CronJob's loop, against a real Nakama:")
total=0
for i in range(1, 21):
    c,body,dt=post("/v2/rpc/recorder_asr_gc?unwrap=true", {"service_token":gc}, tok)
    print("  call %-2d HTTP=%s %5.2fs  %s" % (i, c, dt, body[:110]))
    if c != 200: break
    total+=1
    if '"budget_exhausted":true' not in body: break
print("--- terminated after %d call(s)" % total)

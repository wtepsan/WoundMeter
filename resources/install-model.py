#!/usr/bin/env python3
"""Install the exact approved model from a trusted local file or HTTPS artifact URL."""
import hashlib, os, shutil, sys, tempfile, urllib.request
from pathlib import Path
root=Path(__file__).resolve().parent/'models'
expected=(root/'SHA256SUMS').read_text().split()[0]
if len(sys.argv)!=2: raise SystemExit('Usage: python3 resources/install-model.py /trusted/best.pt OR https://trusted-host/best.pt')
source=sys.argv[1]
fd,tmp=tempfile.mkstemp(dir=root)
try:
 with os.fdopen(fd,'wb') as target:
  if source.startswith('https://'):
   with urllib.request.urlopen(source,timeout=60) as response: shutil.copyfileobj(response,target)
  else:
   with open(source,'rb') as stream: shutil.copyfileobj(stream,target)
 if hashlib.sha256(Path(tmp).read_bytes()).hexdigest()!=expected: raise SystemExit('Model checksum mismatch; installation refused.')
 os.chmod(tmp,0o644)
 os.replace(tmp,root/'best.pt')
 print('Installed checksum-verified best.pt.')
finally:
 Path(tmp).unlink(missing_ok=True)

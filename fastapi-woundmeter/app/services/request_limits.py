"""Bound request bytes before JSON/base64 parsing, including chunked bodies."""
from starlette.responses import JSONResponse


class RequestBodyLimit:
    def __init__(self, app, max_bytes: int):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('method') not in {'POST', 'PUT', 'PATCH'}:
            return await self.app(scope, receive, send)
        headers = dict(scope.get('headers', []))
        try:
            declared = int(headers.get(b'content-length', b'0'))
        except ValueError:
            declared = self.max_bytes + 1
        async def reject():
            await JSONResponse({'code': 'REQUEST_TOO_LARGE', 'message': 'The upload request is too large.'}, status_code=413)(scope, receive, send)
        if declared > self.max_bytes:
            return await reject()
        chunks, size = [], 0
        while True:
            event = await receive()
            if event['type'] == 'http.disconnect':
                return
            chunk = event.get('body', b'')
            size += len(chunk)
            if size > self.max_bytes:
                return await reject()
            chunks.append(chunk)
            if not event.get('more_body', False):
                break
        delivered = False
        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': b''.join(chunks), 'more_body': False}
            return await receive()
        await self.app(scope, replay, send)

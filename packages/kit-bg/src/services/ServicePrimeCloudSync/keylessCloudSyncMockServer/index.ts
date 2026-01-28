import http from 'http';

import type {
  IApiClientResponse,
  ICloudSyncCheckServerStatusPostData,
  ICloudSyncDownloadPostData,
  ICloudSyncUploadPostData,
} from './types';

import { KeylessCloudSyncMockStore } from './keylessCloudSyncMockStore';

export type IKeylessCloudSyncMockServerOptions = {
  host?: string;
  port?: number;
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 17_921;

const store = new KeylessCloudSyncMockStore();

const getHeaderValue = (
  req: http.IncomingMessage,
  headerName: string,
): string | undefined => {
  const value = req.headers[headerName.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const readJsonBody = async (req: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const bodyText = Buffer.concat(chunks).toString('utf8');
  if (!bodyText) {
    return {};
  }
  return JSON.parse(bodyText) as unknown;
};

const sendJson = <T>(
  res: http.ServerResponse,
  statusCode: number,
  payload: IApiClientResponse<T>,
): void => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, x-keyless-public-key, x-keyless-sync-signature',
  });
  res.end(JSON.stringify(payload));
};

export const startKeylessCloudSyncMockServer = (
  options: IKeylessCloudSyncMockServerOptions = {},
): http.Server => {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? '';

      // Handle CORS preflight requests
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, x-keyless-public-key, x-keyless-sync-signature',
          'Access-Control-Max-Age': '86400', // 24 hours
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && url === '/health') {
        sendJson(res, 200, { code: 0, message: 'ok', data: { ok: true } });
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, {
          code: 405,
          message: 'Method not allowed',
          data: null as unknown as null,
        });
        return;
      }

      const publicKey = getHeaderValue(req, 'x-keyless-public-key');
      const signatureHeader = getHeaderValue(req, 'x-keyless-sync-signature');

      if (!publicKey) {
        sendJson(res, 400, {
          code: 400,
          message: 'Missing x-keyless-public-key header',
          data: null as unknown as null,
        });
        return;
      }

      if (url === '/prime/v1/sync/upload-keyless') {
        const body = (await readJsonBody(req)) as ICloudSyncUploadPostData;
        const result = await store.upload({
          publicKey,
          postData: body,
        });
        sendJson(res, 200, { code: 0, message: 'ok', data: result });
        return;
      }

      if (url === '/prime/v1/sync/check-keyless') {
        const body = (await readJsonBody(
          req,
        )) as ICloudSyncCheckServerStatusPostData;
        const result = await store.checkStatus({
          publicKey,
          postData: body,
        });
        sendJson(res, 200, { code: 0, message: 'ok', data: result });
        return;
      }

      if (url === '/prime/v1/sync/download-keyless') {
        const body = (await readJsonBody(req)) as ICloudSyncDownloadPostData;
        const result = await store.download({
          publicKey,
          signatureHeader: signatureHeader ?? '',
          postData: body,
        });
        sendJson(res, 200, { code: 0, message: 'ok', data: result });
        return;
      }

      if (url === '/prime/v1/sync/clear-keyless') {
        store.clear();
        sendJson(res, 200, {
          code: 0,
          message: 'ok',
          data: { cleared: true },
        });
        return;
      }

      sendJson(res, 404, {
        code: 404,
        message: 'Not found',
        data: null as unknown as null,
      });
    } catch (error) {
      sendJson(res, 500, {
        code: 500,
        message: error instanceof Error ? error.message : 'Server error',
        data: null as unknown as null,
      });
    }
  });

  server.listen(port, host, () => {
    console.log(
      `[MockServer] Keyless cloud sync mock server listening on http://${host}:${port}`,
    );
  });

  return server;
};

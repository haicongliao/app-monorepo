import crypto from 'crypto';
import http from 'http';

import * as secp256k1 from '@noble/secp256k1';
import safeStringify from 'fast-safe-stringify';

import { KeylessCloudSyncMockStore } from './keylessCloudSyncMockStore';

import type {
  IApiClientResponse,
  ICloudSyncCheckServerStatusPostData,
  ICloudSyncDownloadPostData,
  ICloudSyncUploadPostData,
} from './types';

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

/**
 * Deterministic JSON serialization (uses fast-safe-stringify, same as client)
 */
const stableStringify = (obj: unknown): string => {
  return safeStringify.stableStringify(obj);
};

/**
 * Parse Base64-encoded signature header
 */
const parseSignatureHeader = (
  signatureHeader: string,
): {
  publicKey: string;
  signature: string;
  timestamp: number;
  nonce: string;
} | null => {
  try {
    const decoded = Buffer.from(signatureHeader, 'base64').toString('utf8');
    return JSON.parse(decoded) as {
      publicKey: string;
      signature: string;
      timestamp: number;
      nonce: string;
    };
  } catch {
    return null;
  }
};

/**
 * Compute SHA256 hash of data
 */
const computeDataHash = (data: string): string => {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
};

/**
 * Verify signature using secp256k1
 */
const verifySignature = async ({
  publicKey,
  signature,
  timestamp,
  nonce,
  dataHash,
}: {
  publicKey: string;
  signature: string;
  timestamp: number;
  nonce: string;
  dataHash?: string;
}): Promise<boolean> => {
  try {
    // Reconstruct the sign message (same as client-side buildKeylessSignatureHeader)
    const signMessage: {
      timestamp: number;
      nonce: string;
      dataHash?: string;
    } = {
      timestamp,
      nonce,
      ...(dataHash ? { dataHash } : {}),
    };

    // Use stableStringify for deterministic serialization
    const messageString = stableStringify(signMessage);

    // Compute SHA256 hash
    const messageHash = crypto
      .createHash('sha256')
      .update(messageString, 'utf8')
      .digest();

    // Verify signature using secp256k1
    const isValid = secp256k1.verify(
      signature,
      messageHash,
      publicKey,
      // Use strict: false to allow non-strict DER signatures
      { strict: false },
    );

    return isValid;
  } catch (error) {
    console.error('[MockServer] Signature verification error:', error);
    return false;
  }
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

        // Verify signature for upload (must include dataHash)
        if (!signatureHeader) {
          sendJson(res, 401, {
            code: 401,
            message: 'Missing x-keyless-sync-signature header',
            data: null as unknown as null,
          });
          return;
        }

        const signaturePayload = parseSignatureHeader(signatureHeader);
        if (!signaturePayload) {
          sendJson(res, 401, {
            code: 401,
            message: 'Invalid signature header format',
            data: null as unknown as null,
          });
          return;
        }

        // Compute dataHash from postData using stableStringify
        const postDataString = stableStringify(body);
        const dataHash = computeDataHash(postDataString);

        // Verify signature with dataHash
        const isValid = await verifySignature({
          publicKey: signaturePayload.publicKey,
          signature: signaturePayload.signature,
          timestamp: signaturePayload.timestamp,
          nonce: signaturePayload.nonce,
          dataHash,
        });

        if (!isValid) {
          sendJson(res, 401, {
            code: 401,
            message: 'Invalid signature',
            data: null as unknown as null,
          });
          return;
        }

        // Verify publicKey matches
        if (signaturePayload.publicKey !== publicKey) {
          sendJson(res, 401, {
            code: 401,
            message: 'Public key mismatch',
            data: null as unknown as null,
          });
          return;
        }

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

        // Verify signature for checkStatus
        if (!signatureHeader) {
          sendJson(res, 401, {
            code: 401,
            message: 'Missing x-keyless-sync-signature header',
            data: null as unknown as null,
          });
          return;
        }

        const signaturePayload = parseSignatureHeader(signatureHeader);
        if (!signaturePayload) {
          sendJson(res, 401, {
            code: 401,
            message: 'Invalid signature header format',
            data: null as unknown as null,
          });
          return;
        }

        // Verify signature (no dataHash for checkStatus)
        const isValid = await verifySignature({
          publicKey: signaturePayload.publicKey,
          signature: signaturePayload.signature,
          timestamp: signaturePayload.timestamp,
          nonce: signaturePayload.nonce,
        });

        if (!isValid) {
          sendJson(res, 401, {
            code: 401,
            message: 'Invalid signature',
            data: null as unknown as null,
          });
          return;
        }

        // Verify publicKey matches
        if (signaturePayload.publicKey !== publicKey) {
          sendJson(res, 401, {
            code: 401,
            message: 'Public key mismatch',
            data: null as unknown as null,
          });
          return;
        }

        const result = await store.checkStatus({
          publicKey,
          postData: body,
        });
        sendJson(res, 200, { code: 0, message: 'ok', data: result });
        return;
      }

      if (url === '/prime/v1/sync/download-keyless') {
        const body = (await readJsonBody(req)) as ICloudSyncDownloadPostData;

        // Verify signature for download
        if (!signatureHeader) {
          sendJson(res, 401, {
            code: 401,
            message: 'Missing x-keyless-sync-signature header',
            data: null as unknown as null,
          });
          return;
        }

        const signaturePayload = parseSignatureHeader(signatureHeader);
        if (!signaturePayload) {
          sendJson(res, 401, {
            code: 401,
            message: 'Invalid signature header format',
            data: null as unknown as null,
          });
          return;
        }

        // Verify signature (no dataHash for download)
        const isValid = await verifySignature({
          publicKey: signaturePayload.publicKey,
          signature: signaturePayload.signature,
          timestamp: signaturePayload.timestamp,
          nonce: signaturePayload.nonce,
        });

        if (!isValid) {
          sendJson(res, 401, {
            code: 401,
            message: 'Invalid signature',
            data: null as unknown as null,
          });
          return;
        }

        // Verify publicKey matches
        if (signaturePayload.publicKey !== publicKey) {
          sendJson(res, 401, {
            code: 401,
            message: 'Public key mismatch',
            data: null as unknown as null,
          });
          return;
        }

        const result = await store.download({
          publicKey,
          signatureHeader: signatureHeader ?? '',
          postData: body,
        });
        sendJson(res, 200, { code: 0, message: 'ok', data: result });
        return;
      }

      if (url === '/prime/v1/sync/clear-keyless') {
        // Clear does not require signature verification (as per requirement)
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

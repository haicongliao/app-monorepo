/**
 * Keyless Cloud Sync Utilities
 *
 * Provides key derivation, encryption/decryption, and signing functionality for Keyless cloud sync.
 * Uses the unique Keyless wallet mnemonic to derive keys for operations.
 */

import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';

import {
  batchGetPrivateKeys,
  decryptStringAsync,
  encryptStringAsync,
  publicFromPrivate,
  sign,
} from '@onekeyhq/core/src/secret';
import type { ICoreHdCredentialEncryptHex } from '@onekeyhq/core/src/types';
import {
  KEYLESS_PWDHASH_CONTEXT,
  KEYLESS_PWDHASH_PREFIX,
  KEYLESS_SYNC_DERIVATION_PATH_PREFIX,
  KEYLESS_SYNC_ENCRYPTION_CONTEXT,
} from '@onekeyhq/shared/src/consts/keylessCloudSyncConsts';
import { OneKeyLocalError } from '@onekeyhq/shared/src/errors';
import bufferUtils from '@onekeyhq/shared/src/utils/bufferUtils';
import type {
  IKeylessCloudSyncCredential,
  IKeylessCloudSyncSignMessage,
  IKeylessCloudSyncSignaturePayload,
} from '@onekeyhq/shared/types/keylessCloudSync';

/**
 * Compute pwdHash for Keyless mode
 *
 * Format: `keyless-{sha512(context:encryptionKey)}`
 *
 * @param encryptionKey - Keyless encryption key (hex string)
 * @returns pwdHash string with 'keyless-' prefix
 */
export function computeKeylessPwdHash(encryptionKey: string): string {
  const context: string = KEYLESS_PWDHASH_CONTEXT;
  const hashInput = `${context}:${encryptionKey}`;
  const hash = sha512(bufferUtils.toBuffer(hashInput, 'utf8'));
  const prefix: string = KEYLESS_PWDHASH_PREFIX;
  return `${prefix}${bufferUtils.bytesToHex(hash)}`;
}

/**
 * Check if pwdHash is a Keyless pwdHash
 *
 * @param pwdHash - pwdHash string to check
 * @returns true if pwdHash starts with 'keyless-' prefix
 */
export function isKeylessPwdHash(pwdHash: string): boolean {
  return pwdHash.startsWith(KEYLESS_PWDHASH_PREFIX);
}

/**
 * Derive sync credentials from Keyless wallet
 *
 * @param hdCredential - Keyless wallet credential (from localDb.getCredential(keylessWalletId))
 * @param password - Wallet password
 * @param keylessWalletId - Keyless wallet ID
 * @returns Keyless sync credentials containing signing and encryption keys
 */
export async function deriveKeylessCredential({
  hdCredential,
  password,
  keylessWalletId,
}: {
  hdCredential: ICoreHdCredentialEncryptHex;
  password: string;
  keylessWalletId: string;
}): Promise<IKeylessCloudSyncCredential> {
  // Batch derive private keys for two paths
  // 0/0 = signing key, 0/1 = encryption key
  const keys = await batchGetPrivateKeys(
    'secp256k1',
    hdCredential,
    password,
    KEYLESS_SYNC_DERIVATION_PATH_PREFIX, // "m/44'/1919'/0'"
    ['0/0', '0/1'],
  );

  const signingKey = keys.find((k) => k.path.endsWith('0/0'));
  const encryptionKeyInfo = keys.find((k) => k.path.endsWith('0/1'));

  if (!signingKey || !encryptionKeyInfo) {
    throw new OneKeyLocalError('Failed to derive keyless sync keys');
  }

  // Derive public key from private key
  const signingPublicKey = await publicFromPrivate(
    'secp256k1',
    signingKey.extendedKey.key,
    password,
  );

  const encryptionKeyHex = bufferUtils.bytesToHex(
    encryptionKeyInfo.extendedKey.key,
  );

  return {
    keylessWalletId,
    signingPrivateKey: bufferUtils.bytesToHex(signingKey.extendedKey.key),
    signingPublicKey: bufferUtils.bytesToHex(signingPublicKey),
    encryptionKey: encryptionKeyHex,
    pwdHash: computeKeylessPwdHash(encryptionKeyHex),
  };
}

/**
 * Encrypt data using Keyless derived key
 *
 * @param rawData - Raw data to encrypt (JSON string)
 * @param encryptionKey - Encryption key (hex)
 * @returns Encrypted data (hex string)
 */
export async function encryptWithKeylessKey({
  rawData,
  encryptionKey,
}: {
  rawData: string;
  encryptionKey: string;
}): Promise<string> {
  // Build password using encryption key and context identifier
  const password = `${encryptionKey}:${KEYLESS_SYNC_ENCRYPTION_CONTEXT}`;
  return encryptStringAsync({
    password,
    data: rawData,
    dataEncoding: 'utf8',
    allowRawPassword: true,
  });
}

/**
 * Decrypt data using Keyless derived key
 *
 * @param encryptedData - Encrypted data (hex string)
 * @param encryptionKey - Encryption key (hex)
 * @returns Decrypted raw data (UTF8 string)
 */
export async function decryptWithKeylessKey({
  encryptedData,
  encryptionKey,
}: {
  encryptedData: string;
  encryptionKey: string;
}): Promise<string> {
  const password = `${encryptionKey}:${KEYLESS_SYNC_ENCRYPTION_CONTEXT}`;
  return decryptStringAsync({
    password,
    data: encryptedData,
    dataEncoding: 'hex',
    resultEncoding: 'utf8',
    allowRawPassword: true,
  });
}

/**
 * Generate random nonce (for replay protection)
 */
function generateNonce(): string {
  const randomBytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    // Fallback for environments without crypto
    for (let i = 0; i < 16; i += 1) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bufferUtils.bytesToHex(randomBytes);
}

/**
 * Sign message and build Header content
 *
 * @param signingPrivateKey - Signing private key (hex)
 * @param signingPublicKey - Signing public key (hex)
 * @param password - Wallet password (for decrypting private key)
 * @param dataHash - Data hash to include when uploading (optional)
 * @returns Base64 encoded signature Header value
 */
export async function buildKeylessSignatureHeader({
  signingPrivateKey,
  signingPublicKey,
  password,
  dataHash,
}: {
  signingPrivateKey: string;
  signingPublicKey: string;
  password: string;
  dataHash?: string;
}): Promise<string> {
  const timestamp = Date.now();
  const nonce = generateNonce();

  // Construct sign message
  const signMessage: IKeylessCloudSyncSignMessage = {
    timestamp,
    nonce,
    ...(dataHash ? { dataHash } : {}),
  };

  // Compute message hash
  const messageString = JSON.stringify(signMessage);
  const messageHash = sha256(bufferUtils.toBuffer(messageString, 'utf8'));

  // Sign (private key is encrypted, needs password to decrypt)
  const signature = await sign(
    'secp256k1',
    bufferUtils.toBuffer(signingPrivateKey, 'hex'),
    Buffer.from(messageHash),
    password,
  );

  // Construct Header payload
  const headerPayload: IKeylessCloudSyncSignaturePayload = {
    publicKey: signingPublicKey,
    signature: bufferUtils.bytesToHex(signature),
    timestamp,
    nonce,
  };

  // Base64 encode
  return bufferUtils.bytesToBase64(
    bufferUtils.toBuffer(JSON.stringify(headerPayload), 'utf8'),
  );
}

/**
 * Compute SHA256 hash of data
 *
 * @param data - Data to hash
 * @returns Hash value (hex string)
 */
export function computeDataHash(data: string): string {
  const hash = sha256(bufferUtils.toBuffer(data, 'utf8'));
  return bufferUtils.bytesToHex(hash);
}

/**
 * Parse signature Header (for server or local verification)
 *
 * @param signatureHeader - Base64 encoded signature Header
 * @returns Parsed signature payload
 */
export function parseSignatureHeader(
  signatureHeader: string,
): IKeylessCloudSyncSignaturePayload | null {
  try {
    const decoded = bufferUtils.bytesToUtf8(
      bufferUtils.base64ToBytes(signatureHeader),
    );
    return JSON.parse(decoded) as IKeylessCloudSyncSignaturePayload;
  } catch {
    return null;
  }
}

/* eslint-disable no-continue */

import { KEYLESS_SYNC_SIGNATURE_HEADER } from '@onekeyhq/shared/src/consts/keylessCloudSyncConsts';
import { OneKeyLocalError } from '@onekeyhq/shared/src/errors';
import type { IApiClientResponse } from '@onekeyhq/shared/types/endpoint';
import type {
  ICloudSyncCheckServerStatusPostData,
  ICloudSyncCheckServerStatusResult,
  ICloudSyncDownloadPostData,
  ICloudSyncDownloadResult,
  ICloudSyncUploadPostData,
  ICloudSyncUploadResult,
} from '@onekeyhq/shared/types/prime/primeCloudSyncTypes';

import type { AxiosInstance } from 'axios';

const ENV_KEYLESS_SYNC_MOCK_SERVER_URL = 'KEYLESS_CLOUD_SYNC_MOCK_SERVER_URL';

class KeylessCloudSyncMockApi {
  private getMockServerUrl(): string | undefined {
    try {
      return (
        process?.env?.[ENV_KEYLESS_SYNC_MOCK_SERVER_URL] ||
        'http://127.0.0.1:17921'
      );
    } catch {
      return undefined;
    }
  }

  private async postToMockServer<T>({
    client,
    url,
    signatureHeader,
    postData,
  }: {
    client: AxiosInstance;
    url: string;
    signatureHeader: string;
    postData: unknown;
  }): Promise<T> {
    const mockServerUrl = this.getMockServerUrl();
    if (!mockServerUrl) {
      throw new OneKeyLocalError('Mock server URL is not set');
    }

    try {
      const response = await client.post<IApiClientResponse<T>>(url, postData, {
        baseURL: mockServerUrl,
        headers: {
          // x-keyless-sync-signature already contains publicKey, no need for separate header
          [KEYLESS_SYNC_SIGNATURE_HEADER]: signatureHeader,
        },
      });
      if (response?.data?.data) {
        return response.data.data;
      }
      return response?.data as unknown as T;
    } catch (error) {
      console.warn('[MockAPI] Mock server unavailable, fallback to memory.', {
        url,
        error,
      });
      throw error;
    }
  }

  async upload(params: {
    client: AxiosInstance;
    signatureHeader: string;
    postData: ICloudSyncUploadPostData;
  }): Promise<ICloudSyncUploadResult | undefined> {
    return this.postToMockServer<ICloudSyncUploadResult>({
      client: params.client,
      url: '/prime/v1/sync/upload-keyless',
      signatureHeader: params.signatureHeader,
      postData: params.postData,
    });
  }

  async checkStatus(params: {
    client: AxiosInstance;
    signatureHeader: string;
    postData: ICloudSyncCheckServerStatusPostData;
  }): Promise<{
    result: ICloudSyncCheckServerStatusResult;
    serverTime: string;
  }> {
    return this.postToMockServer<{
      result: ICloudSyncCheckServerStatusResult;
      serverTime: string;
    }>({
      client: params.client,
      url: '/prime/v1/sync/check-keyless',
      signatureHeader: params.signatureHeader,
      postData: params.postData,
    });
  }

  async download(params: {
    client: AxiosInstance;
    signatureHeader?: string;
    postData: ICloudSyncDownloadPostData;
  }): Promise<ICloudSyncDownloadResult> {
    if (params.signatureHeader) {
      return this.postToMockServer<ICloudSyncDownloadResult>({
        client: params.client,
        url: '/prime/v1/sync/download-keyless',
        signatureHeader: params.signatureHeader,
        postData: params.postData,
      });
    }

    throw new OneKeyLocalError('Signature header is not set');
  }

  async clear(params: {
    client: AxiosInstance;
    signatureHeader: string;
  }): Promise<void> {
    await this.postToMockServer<{ cleared: boolean }>({
      client: params.client,
      url: '/prime/v1/sync/clear-keyless',
      signatureHeader: params.signatureHeader,
      postData: {},
    });
  }
}

export const keylessMockApi = new KeylessCloudSyncMockApi();

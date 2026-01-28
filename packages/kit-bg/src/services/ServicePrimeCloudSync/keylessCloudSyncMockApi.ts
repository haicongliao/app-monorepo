/* eslint-disable no-continue */

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
    publicKey,
    signatureHeader,
    postData,
  }: {
    client: AxiosInstance;
    url: string;
    publicKey: string;
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
          'x-keyless-public-key': publicKey,
          'x-keyless-sync-signature': signatureHeader,
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
    publicKey: string;
    signatureHeader: string;
    postData: ICloudSyncUploadPostData;
  }): Promise<ICloudSyncUploadResult | undefined> {
    void params.client.post<IApiClientResponse<ICloudSyncUploadResult>>(
      '/prime/v1/sync/upload-keyless',
      params.postData,
    );

    return this.postToMockServer<ICloudSyncUploadResult>({
      client: params.client,
      url: '/prime/v1/sync/upload-keyless',
      publicKey: params.publicKey,
      signatureHeader: params.signatureHeader,
      postData: params.postData,
    });
  }

  async checkStatus(params: {
    client: AxiosInstance;
    publicKey: string;
    signatureHeader: string;
    postData: ICloudSyncCheckServerStatusPostData;
  }): Promise<{
    result: ICloudSyncCheckServerStatusResult;
    serverTime: string;
  }> {
    void params.client.post<
      IApiClientResponse<ICloudSyncCheckServerStatusResult>
    >('/prime/v1/sync/check-keyless', {
      ...params.postData,
    });

    return this.postToMockServer<{
      result: ICloudSyncCheckServerStatusResult;
      serverTime: string;
    }>({
      client: params.client,
      url: '/prime/v1/sync/check-keyless',
      publicKey: params.publicKey,
      signatureHeader: params.signatureHeader,
      postData: params.postData,
    });
  }

  async download(params: {
    client: AxiosInstance;
    publicKey?: string;
    signatureHeader?: string;
    postData: ICloudSyncDownloadPostData;
  }): Promise<ICloudSyncDownloadResult> {
    void params.client.post<IApiClientResponse<ICloudSyncDownloadResult>>(
      '/prime/v1/sync/download-keyless',
      params.postData,
    );

    if (params.publicKey && params.signatureHeader) {
      return this.postToMockServer<ICloudSyncDownloadResult>({
        client: params.client,
        url: '/prime/v1/sync/download-keyless',
        publicKey: params.publicKey,
        signatureHeader: params.signatureHeader,
        postData: params.postData,
      });
    }

    throw new OneKeyLocalError('Public key or signature header is not set');
  }

  async clear(params: {
    client: AxiosInstance;
    publicKey: string;
    signatureHeader: string;
  }): Promise<void> {
    await this.postToMockServer<{ cleared: boolean }>({
      client: params.client,
      url: '/prime/v1/sync/clear-keyless',
      publicKey: params.publicKey,
      signatureHeader: params.signatureHeader,
      postData: {},
    });
  }
}

export const keylessMockApi = new KeylessCloudSyncMockApi();

/* eslint-disable no-continue */

import type { IApiClientResponse } from '@onekeyhq/shared/types/endpoint';
import type {
  ICloudSyncCheckServerStatusPostData,
  ICloudSyncCheckServerStatusResult,
  ICloudSyncDownloadPostData,
  ICloudSyncDownloadResult,
  ICloudSyncServerItem,
  ICloudSyncServerItemByDownloaded,
  ICloudSyncUploadPostData,
  ICloudSyncUploadResult,
} from '@onekeyhq/shared/types/prime/primeCloudSyncTypes';

import type { AxiosInstance } from 'axios';

class KeylessCloudSyncMockApi {
  private storage: Map<string, ICloudSyncServerItem[]> = new Map();

  private getStorageKey(publicKey: string): string {
    return `keyless_${publicKey.slice(0, 32)}`;
  }

  private async timeNow(): Promise<number> {
    return Date.now();
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

    const key = this.getStorageKey(params.publicKey);
    const existingItems = this.storage.get(key) ?? [];
    const itemMap = new Map(existingItems.map((item) => [item.key, item]));
    const items = params.postData.localData ?? [];
    let created = 0;
    let updated = 0;

    for (const newItem of items) {
      const existing = itemMap.get(newItem.key);
      if (existing) {
        existing.keylessData = newItem.keylessData;
        existing.keylessDataTimestamp = newItem.keylessDataTimestamp;
        existing.isDeleted = newItem.isDeleted;
        updated += 1;
      } else {
        itemMap.set(newItem.key, newItem);
        created += 1;
      }
    }

    this.storage.set(key, Array.from(itemMap.values()));
    console.log(
      '[MockAPI] Keyless upload success:',
      key,
      items.length,
      'items',
    );
    return {
      nonce: 0,
      created,
      updated,
    };
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

    const key = this.getStorageKey(params.publicKey);
    const mockedServerItems = this.storage.get(key) ?? [];
    const onlyCheckLocalDataType = new Set(
      params.postData.onlyCheckLocalDataType,
    );
    const filteredLocalItems = params.postData.localData.filter((item) =>
      onlyCheckLocalDataType.has(item.dataType),
    );
    const serverItems = mockedServerItems.filter((item) =>
      onlyCheckLocalDataType.has(item.dataType),
    );

    const toKey = (item: { key: string; dataType: string }) =>
      `${item.dataType}:${item.key}`;
    const localMap = new Map(
      filteredLocalItems.map((item) => [toKey(item), item]),
    );
    const serverMap = new Map(serverItems.map((item) => [toKey(item), item]));

    const getLocalTime = (item: { dataTimestamp: number | undefined }) =>
      item.dataTimestamp ?? 0;
    const getServerTime = (item: ICloudSyncServerItem) =>
      item.keylessDataTimestamp ?? item.dataTimestamp ?? 0;

    const obsoleted: string[] = [];
    const updated: ICloudSyncServerItem[] = [];
    const deleted: string[] = [];
    const diff: ICloudSyncServerItem[] = [];

    for (const localItem of filteredLocalItems) {
      const serverItem = serverMap.get(toKey(localItem));
      const localTime = getLocalTime(localItem);

      if (!serverItem) {
        obsoleted.push(localItem.key);
        continue;
      }

      const serverTime = getServerTime(serverItem);

      if (serverItem.isDeleted) {
        if (serverTime >= localTime) {
          deleted.push(serverItem.key);
        } else {
          obsoleted.push(localItem.key);
        }
        continue;
      }

      if (serverTime > localTime) {
        updated.push(serverItem);
      } else if (localTime > serverTime) {
        obsoleted.push(localItem.key);
      }
    }

    for (const serverItem of serverItems) {
      if (localMap.has(toKey(serverItem))) {
        continue;
      }
      if (serverItem.isDeleted) {
        deleted.push(serverItem.key);
      } else {
        updated.push(serverItem);
      }
    }

    return {
      result: {
        deleted,
        diff,
        updated,
        obsoleted,
        pwdHash: '',
        serverTime: await this.timeNow(),
      },
      serverTime: new Date().toISOString(),
    };
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

    if (!params.publicKey || !params.signatureHeader) {
      return {
        nonce: 0,
        serverData: [],
        pwdHash: '',
      };
    }

    const key = this.getStorageKey(params.publicKey);
    const serverData = this.storage.get(key) ?? [];
    const sliced = serverData.slice(
      params.postData.start ?? 0,
      params.postData.limit
        ? (params.postData.start ?? 0) + params.postData.limit
        : undefined,
    );
    const filtered = params.postData.includeDeleted
      ? sliced
      : sliced.filter((item) => !item.isDeleted);
    const now = await this.timeNow();
    const mapped: ICloudSyncServerItemByDownloaded[] = filtered.map((item) => ({
      ...item,
      dataTimestamp: item.dataTimestamp ?? item.keylessDataTimestamp ?? now,
    }));
    return {
      nonce: 0,
      serverData: mapped,
      pwdHash: '',
    };
  }

  clear(): void {
    this.storage.clear();
    console.log('[MockAPI] Keyless storage cleared');
  }
}

export const keylessMockApi = new KeylessCloudSyncMockApi();

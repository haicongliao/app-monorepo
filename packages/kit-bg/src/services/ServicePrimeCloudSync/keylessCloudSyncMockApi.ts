import type { ICloudSyncServerItem } from '@onekeyhq/shared/types/prime/primeCloudSyncTypes';

class KeylessCloudSyncMockApi {
  private storage: Map<string, ICloudSyncServerItem[]> = new Map();

  private getStorageKey(publicKey: string): string {
    return `keyless_${publicKey.slice(0, 32)}`;
  }

  async upload(params: {
    publicKey: string;
    signatureHeader: string;
    items: ICloudSyncServerItem[];
  }): Promise<{ success: boolean; message?: string }> {
    const key = this.getStorageKey(params.publicKey);
    const existingItems = this.storage.get(key) ?? [];
    const itemMap = new Map(existingItems.map((item) => [item.key, item]));

    for (const newItem of params.items) {
      const existing = itemMap.get(newItem.key);
      if (existing) {
        existing.keylessData = newItem.keylessData;
        existing.keylessDataTimestamp = newItem.keylessDataTimestamp;
        existing.isDeleted = newItem.isDeleted;
      } else {
        itemMap.set(newItem.key, newItem);
      }
    }

    this.storage.set(key, Array.from(itemMap.values()));
    console.log(
      '[MockAPI] Keyless upload success:',
      key,
      params.items.length,
      'items',
    );
    return { success: true };
  }

  async query(params: {
    publicKey: string;
    signatureHeader: string;
    dataTypes?: string[];
  }): Promise<{
    items: ICloudSyncServerItem[];
    hasMore: boolean;
  }> {
    const key = this.getStorageKey(params.publicKey);
    let items = this.storage.get(key) ?? [];

    if (params.dataTypes?.length) {
      items = items.filter((item) => params.dataTypes?.includes(item.dataType));
    }

    console.log('[MockAPI] Keyless query:', key, items.length, 'items found');
    return { items, hasMore: false };
  }

  clear(): void {
    this.storage.clear();
    console.log('[MockAPI] Keyless storage cleared');
  }
}

export const keylessMockApi = new KeylessCloudSyncMockApi();

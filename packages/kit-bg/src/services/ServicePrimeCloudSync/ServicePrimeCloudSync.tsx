/* eslint-disable no-continue */
import { debounce, isNil, throttle, uniqBy } from 'lodash';

import type { IBrowserBookmark } from '@onekeyhq/kit/src/views/Discovery/types';
import {
  backgroundClass,
  backgroundMethod,
  backgroundMethodForDev,
  toastIfError,
} from '@onekeyhq/shared/src/background/backgroundDecorators';
import {
  ALWAYS_VERIFY_PASSCODE_WHEN_CHANGE_SET_MASTER_PASSWORD,
  EPrimeCloudSyncDataType,
  RESET_CLOUD_SYNC_MASTER_PASSWORD_UUID,
} from '@onekeyhq/shared/src/consts/primeConsts';
import {
  OneKeyError,
  OneKeyErrorPrimeMasterPasswordInvalid,
  OneKeyErrorPrimePaidMembershipRequired,
  OneKeyLocalError,
} from '@onekeyhq/shared/src/errors';
import { EOneKeyErrorClassNames } from '@onekeyhq/shared/src/errors/types/errorTypes';
import errorUtils from '@onekeyhq/shared/src/errors/utils/errorUtils';
import {
  EAppEventBusNames,
  appEventBus,
} from '@onekeyhq/shared/src/eventBus/appEventBus';
import { ETranslations } from '@onekeyhq/shared/src/locale';
import { appLocale } from '@onekeyhq/shared/src/locale/appLocale';
import { memoizee } from '@onekeyhq/shared/src/utils/cacheUtils';
import stringUtils from '@onekeyhq/shared/src/utils/stringUtils';
import systemTimeUtils, {
  ELocalSystemTimeStatus,
} from '@onekeyhq/shared/src/utils/systemTimeUtils';
import timerUtils from '@onekeyhq/shared/src/utils/timerUtils';
import type { IServerNetwork } from '@onekeyhq/shared/types';
import type { IDBCustomRpc } from '@onekeyhq/shared/types/customRpc';
import type { IApiClientResponse } from '@onekeyhq/shared/types/endpoint';
import { ECloudSyncMode } from '@onekeyhq/shared/types/keylessCloudSync';
import type { IKeylessCloudSyncCredential } from '@onekeyhq/shared/types/keylessCloudSync';
import type { IMarketWatchListItemV2 } from '@onekeyhq/shared/types/market';
import type {
  ICloudSyncCheckServerStatusPostData,
  ICloudSyncCheckServerStatusResult,
  ICloudSyncCredential,
  ICloudSyncCredentialForLock,
  ICloudSyncDownloadPostData,
  ICloudSyncDownloadResult,
  ICloudSyncRawDataJson,
  ICloudSyncServerDiffItem,
  ICloudSyncServerItem,
  ICloudSyncServerItemByDownloaded,
  ICloudSyncUploadPostData,
  ICloudSyncUploadResult,
  IStartServerSyncFlowParams,
} from '@onekeyhq/shared/types/prime/primeCloudSyncTypes';
import type { IPrimeServerUserInfo } from '@onekeyhq/shared/types/prime/primeTypes';
import { EReasonForNeedPassword } from '@onekeyhq/shared/types/setting';
import type {
  IPrimeConfigFlushInfo,
  IPrimeLockChangedInfo,
} from '@onekeyhq/shared/types/socket';
import type { ICloudSyncCustomToken } from '@onekeyhq/shared/types/token';

import localDb from '../../dbs/local/localDb';
import { ELocalDBStoreNames } from '../../dbs/local/localDBStoreNames';
import {
  EIndexedDBBucketNames,
  type IDBAccount,
  type IDBCloudSyncItem,
  type IDBIndexedAccount,
  type IDBWallet,
} from '../../dbs/local/types';
import {
  addressBookPersistAtom,
  devSettingsPersistAtom,
  primeCloudSyncPersistAtom,
  primeMasterPasswordPersistAtom,
  primePersistAtom,
} from '../../states/jotai/atoms';
import ServiceBase from '../ServiceBase';

import { CloudSyncFlowManagerAccount } from './CloudSyncFlowManager/CloudSyncFlowManagerAccount';
import { CloudSyncFlowManagerAddressBook } from './CloudSyncFlowManager/CloudSyncFlowManagerAddressBook';
import { CloudSyncFlowManagerBrowserBookmark } from './CloudSyncFlowManager/CloudSyncFlowManagerBrowserBookmark';
import { CloudSyncFlowManagerCustomNetwork } from './CloudSyncFlowManager/CloudSyncFlowManagerCustomNetwork';
import { CloudSyncFlowManagerCustomRpc } from './CloudSyncFlowManager/CloudSyncFlowManagerCustomRpc';
import { CloudSyncFlowManagerCustomToken } from './CloudSyncFlowManager/CloudSyncFlowManagerCustomToken';
import { CloudSyncFlowManagerIndexedAccount } from './CloudSyncFlowManager/CloudSyncFlowManagerIndexedAccount';
import { CloudSyncFlowManagerLock } from './CloudSyncFlowManager/CloudSyncFlowManagerLock';
import { CloudSyncFlowManagerMarketWatchList } from './CloudSyncFlowManager/CloudSyncFlowManagerMarketWatchList';
import { CloudSyncFlowManagerWallet } from './CloudSyncFlowManager/CloudSyncFlowManagerWallet';
import cloudSyncItemBuilder from './cloudSyncItemBuilder';

// Keyless backend API is not available yet; use mock storage for Keyless mode.
import { keylessMockApi } from './keylessCloudSyncMockApi';
import {
  buildKeylessSignatureHeader,
  computeDataHash,
  decryptWithKeylessKey,
  deriveKeylessCredential,
  encryptWithKeylessKey,
} from './keylessCloudSyncUtils';

import type { RealmSchemaCloudSyncItem } from '../../dbs/local/realm/schemas/RealmSchemaCloudSyncItem';
import type { IPrimeCloudSyncPersistAtomData } from '../../states/jotai/atoms';

@backgroundClass()
class ServicePrimeCloudSync extends ServiceBase {
  constructor({ backgroundApi }: { backgroundApi: any }) {
    super({ backgroundApi });
  }

  syncManagers = {
    wallet: new CloudSyncFlowManagerWallet({
      backgroundApi: this.backgroundApi,
    }),
    account: new CloudSyncFlowManagerAccount({
      backgroundApi: this.backgroundApi,
    }),
    indexedAccount: new CloudSyncFlowManagerIndexedAccount({
      backgroundApi: this.backgroundApi,
    }),
    lock: new CloudSyncFlowManagerLock({
      backgroundApi: this.backgroundApi,
    }),
    browserBookmark: new CloudSyncFlowManagerBrowserBookmark({
      backgroundApi: this.backgroundApi,
    }),
    marketWatchList: new CloudSyncFlowManagerMarketWatchList({
      backgroundApi: this.backgroundApi,
    }),
    customRpc: new CloudSyncFlowManagerCustomRpc({
      backgroundApi: this.backgroundApi,
    }),
    customNetwork: new CloudSyncFlowManagerCustomNetwork({
      backgroundApi: this.backgroundApi,
    }),
    customToken: new CloudSyncFlowManagerCustomToken({
      backgroundApi: this.backgroundApi,
    }),
    addressBook: new CloudSyncFlowManagerAddressBook({
      backgroundApi: this.backgroundApi,
    }),
  };

  // ============ Keyless Cloud Sync Methods ============

  /**
   * Keyless credential cache (cleared on password change or wallet removal)
   */
  private keylessCredentialCache: IKeylessCloudSyncCredential | null = null;

  /**
   * Get the unique Keyless wallet in the app
   * @returns Keyless wallet or null if not exists
   */
  async getKeylessWallet(): Promise<IDBWallet | null> {
    const wallet = await this.backgroundApi.serviceAccount.getKeylessWallet();
    return wallet ?? null;
  }

  /**
   * Get or derive Keyless sync credentials
   * @returns Keyless credentials or null if conditions not met
   */
  async getKeylessCredential(): Promise<IKeylessCloudSyncCredential | null> {
    // Check cache first
    if (this.keylessCredentialCache) {
      return this.keylessCredentialCache;
    }

    const keylessWallet = await this.getKeylessWallet();
    if (!keylessWallet) {
      return null;
    }

    const password =
      await this.backgroundApi.servicePassword.getCachedPassword();
    if (!password) {
      return null;
    }

    const credential = await localDb.getCredentialSafe(keylessWallet.id);
    if (!credential?.credential) {
      return null;
    }

    try {
      const keylessCredential = await deriveKeylessCredential({
        hdCredential: credential.credential,
        password,
        keylessWalletId: keylessWallet.id,
      });

      this.keylessCredentialCache = keylessCredential;
      return keylessCredential;
    } catch (error) {
      console.error(
        '[PrimeCloudSync] Failed to derive keyless credential:',
        error,
      );
      return null;
    }
  }

  /**
   * Clear Keyless credential cache
   * Called when: password changed, keyless wallet removed, or user logged out
   */
  clearKeylessCredentialCache(): void {
    this.keylessCredentialCache = null;
  }

  /**
   * Get active sync mode based on configuration and wallet state
   *
   * Rules:
   * 1. If OneKey Cloud sync is enabled → primary mode is OneKey ID (use `data` field)
   * 2. Else if Keyless wallet exists → primary mode is Keyless (use `keylessData` field)
   * 3. Else → no cloud sync, local storage only
   *
   * @returns Active sync mode
   */
  @backgroundMethod()
  async getActiveSyncMode(): Promise<ECloudSyncMode> {
    // Check OneKey Cloud sync switch
    const primeCloudSyncConfig = await primeCloudSyncPersistAtom.get();
    if (primeCloudSyncConfig.isCloudSyncEnabled) {
      // Also need to verify Prime login and subscription
      try {
        const isPrimeLoggedIn =
          await this.backgroundApi.servicePrime.isLoggedIn();
        const isPrimeSubscriptionActive =
          await this.backgroundApi.servicePrime.isPrimeSubscriptionActive();
        if (isPrimeLoggedIn && isPrimeSubscriptionActive) {
          return ECloudSyncMode.OnekeyId;
        }
      } catch (error) {
        errorUtils.autoPrintErrorIgnore(error);
      }
    }

    // Check Keyless wallet existence
    const keylessWallet = await this.getKeylessWallet();
    if (keylessWallet) {
      return ECloudSyncMode.Keyless;
    }

    // No cloud sync
    return ECloudSyncMode.None;
  }

  async getKeylessSyncAuth({
    postData,
  }: {
    postData:
      | ICloudSyncCheckServerStatusPostData
      | ICloudSyncDownloadPostData
      | ICloudSyncUploadPostData;
  }): Promise<{ publicKey: string; signatureHeader: string } | null> {
    const password =
      await this.backgroundApi.servicePassword.getCachedPassword();
    if (!password) {
      return null;
    }

    const keylessCredential = await this.getKeylessCredential();
    if (!keylessCredential) {
      return null;
    }

    const signatureHeader = await buildKeylessSignatureHeader({
      signingPrivateKey: keylessCredential.signingPrivateKey,
      signingPublicKey: keylessCredential.signingPublicKey,
      password,
      dataHash: computeDataHash(stringUtils.stableStringify(postData)),
    });
    return {
      publicKey: keylessCredential.signingPublicKey,
      signatureHeader,
    };
  }

  async apiCheckServerStatusKeyless({
    postData,
  }: {
    postData: ICloudSyncCheckServerStatusPostData;
  }): Promise<{
    result: ICloudSyncCheckServerStatusResult;
    serverTime: string;
  }> {
    const auth = await this.getKeylessSyncAuth({
      postData,
    });
    if (!auth) {
      throw new OneKeyError('Keyless sync auth is not found');
    }

    const client = await this.backgroundApi.servicePrime.getPrimeClient();

    return keylessMockApi.checkStatus({
      client,
      publicKey: auth.publicKey,
      signatureHeader: auth.signatureHeader,
      postData,
    });
  }

  async apiDownloadItemsKeyless({
    postData,
  }: {
    postData: ICloudSyncDownloadPostData;
  }): Promise<ICloudSyncDownloadResult> {
    const auth = await this.getKeylessSyncAuth({
      postData,
    });
    if (!auth) {
      throw new OneKeyError('Keyless sync auth is not found');
    }

    const client = await this.backgroundApi.servicePrime.getPrimeClient();

    return keylessMockApi.download({
      client,
      publicKey: auth?.publicKey,
      signatureHeader: auth?.signatureHeader,
      postData,
    });
  }

  async apiUploadItemsKeyless({
    postData,
  }: {
    postData: ICloudSyncUploadPostData;
  }): Promise<ICloudSyncUploadResult> {
    const auth = await this.getKeylessSyncAuth({
      postData,
    });
    if (!auth) {
      throw new OneKeyError('Keyless sync auth is not found');
    }

    const client = await this.backgroundApi.servicePrime.getPrimeClient();

    const result = await keylessMockApi.upload({
      client,
      publicKey: auth.publicKey,
      signatureHeader: auth.signatureHeader,
      postData,
    });
    return (
      result ?? {
        nonce: 0,
        created: 0,
        updated: 0,
      }
    );
  }

  /**
   * Determine which data source is the latest for a sync item
   *
   * Rules:
   * 1. Both dataTime and keylessDataTime exist → use the later one
   * 2. Only one exists → use the existing one
   * 3. Same timestamp → use current primary mode
   *
   * @param item Local sync item
   * @param primaryMode Current primary mode
   * @returns 'data' | 'keylessData' | null (if both missing)
   */
  determineLatestDataSource(
    item: IDBCloudSyncItem,
    primaryMode: ECloudSyncMode,
  ): 'data' | 'keylessData' | null {
    const hasData = !!item.data;
    const hasKeylessData = !!item.keylessData;
    const dataTime = item.dataTime ?? 0;
    const keylessDataTime = item.keylessDataTime ?? 0;

    // Neither exists
    if (!hasData && !hasKeylessData) {
      return null;
    }

    // Only one exists
    if (hasData && !hasKeylessData) {
      return 'data';
    }
    if (!hasData && hasKeylessData) {
      return 'keylessData';
    }

    // Both exist, compare timestamps
    if (dataTime > keylessDataTime) {
      return 'data';
    }
    if (keylessDataTime > dataTime) {
      return 'keylessData';
    }

    // Same timestamp, use primary mode
    return primaryMode === ECloudSyncMode.Keyless ? 'keylessData' : 'data';
  }

  /**
   * Decrypt sync item data based on source
   *
   * @param item Sync item to decrypt
   * @param source Data source ('data' or 'keylessData')
   * @param syncCredential OneKey ID sync credential (for 'data')
   * @param keylessCredential Keyless credential (for 'keylessData')
   * @returns Decrypted raw data or null if failed
   */
  async decryptSyncItemBySource({
    item,
    source,
    syncCredential,
    keylessCredential,
  }: {
    item: IDBCloudSyncItem;
    source: 'data' | 'keylessData';
    syncCredential: ICloudSyncCredential | undefined;
    keylessCredential: IKeylessCloudSyncCredential | null;
  }): Promise<string | null> {
    try {
      if (source === 'data' && item.data && syncCredential) {
        const decrypted = await cloudSyncItemBuilder.decryptSyncItem({
          item,
          syncCredential,
        });
        // rawData is set on the dbItem during decryption
        return decrypted.dbItem?.rawData ?? null;
      }

      if (source === 'keylessData' && item.keylessData && keylessCredential) {
        return await decryptWithKeylessKey({
          encryptedData: item.keylessData,
          encryptionKey: keylessCredential.encryptionKey,
        });
      }

      return null;
    } catch (error) {
      console.error(`[PrimeCloudSync] Failed to decrypt ${source}:`, error);
      return null;
    }
  }

  /**
   * Convert data between OneKey ID encryption and Keyless encryption
   *
   * This method handles the conversion when switching between sync modes:
   * - When switching to Keyless: decrypt `data` and generate `keylessData`
   * - When switching to OneKey ID: decrypt `keylessData` and generate `data`
   *
   * @param items Items to convert
   * @param targetMode Target encryption mode
   * @param syncCredential OneKey ID credential
   * @param keylessCredential Keyless credential
   * @returns Converted items
   */
  async convertSyncItemsForModeSwitch({
    items,
    targetMode,
    syncCredential,
    keylessCredential,
  }: {
    items: IDBCloudSyncItem[];
    targetMode: ECloudSyncMode;
    syncCredential: ICloudSyncCredential | undefined;
    keylessCredential: IKeylessCloudSyncCredential | null;
  }): Promise<IDBCloudSyncItem[]> {
    if (
      targetMode === ECloudSyncMode.None ||
      (!syncCredential && !keylessCredential)
    ) {
      return items;
    }

    const convertedItems: IDBCloudSyncItem[] = [];

    for (const item of items) {
      try {
        // Lock data type is not included in Keyless sync
        if (item.dataType === EPrimeCloudSyncDataType.Lock) {
          convertedItems.push(item);
          continue;
        }

        // Determine latest data source
        const latestSource = this.determineLatestDataSource(item, targetMode);
        if (!latestSource) {
          // No data to convert, try to use rawData if available
          if (item.rawData) {
            const convertedItem = await this.generateMissingEncryptedData({
              item,
              rawData: item.rawData,
              targetMode,
              syncCredential,
              keylessCredential,
            });
            convertedItems.push(convertedItem);
          } else {
            convertedItems.push(item);
          }
          continue;
        }

        // Decrypt latest data
        let rawData = await this.decryptSyncItemBySource({
          item,
          source: latestSource,
          syncCredential,
          keylessCredential,
        });

        // Fallback: try the other source if decryption failed
        if (!rawData) {
          const fallbackSource =
            latestSource === 'data' ? 'keylessData' : 'data';
          rawData = await this.decryptSyncItemBySource({
            item,
            source: fallbackSource,
            syncCredential,
            keylessCredential,
          });
        }

        // Fallback: use rawData if available
        if (!rawData && item.rawData) {
          rawData = item.rawData;
        }

        if (!rawData) {
          console.warn(
            `[PrimeCloudSync] Cannot decrypt item ${item.id}, skipping conversion`,
          );
          convertedItems.push(item);
          continue;
        }

        // Generate the target encrypted data
        const convertedItem = await this.generateMissingEncryptedData({
          item,
          rawData,
          targetMode,
          syncCredential,
          keylessCredential,
        });

        convertedItems.push(convertedItem);
      } catch (error) {
        console.error(
          `[PrimeCloudSync] Failed to convert item ${item.id}:`,
          error,
        );
        convertedItems.push(item);
      }
    }

    return convertedItems;
  }

  /**
   * Generate missing encrypted data for a sync item
   *
   * @param item Original item
   * @param rawData Decrypted raw data
   * @param targetMode Target mode to generate data for
   * @param syncCredential OneKey ID credential
   * @param keylessCredential Keyless credential
   * @returns Updated item with generated encrypted data
   */
  async generateMissingEncryptedData({
    item,
    rawData,
    targetMode,
    // syncCredential is reserved for future OneKey ID encryption generation
    // Currently OneKey ID encryption is handled by existing flow in buildSyncItem
    syncCredential: _syncCredential,
    keylessCredential,
  }: {
    item: IDBCloudSyncItem;
    rawData: string;
    targetMode: ECloudSyncMode;
    syncCredential: ICloudSyncCredential | undefined;
    keylessCredential: IKeylessCloudSyncCredential | null;
  }): Promise<IDBCloudSyncItem> {
    void _syncCredential; // Reserved for future use
    const updatedItem: IDBCloudSyncItem = { ...item, rawData };
    const now = await this.timeNow();

    // Generate Keyless encrypted data if targeting Keyless mode
    if (
      (targetMode === ECloudSyncMode.Keyless ||
        targetMode === ECloudSyncMode.OnekeyId) &&
      keylessCredential &&
      !item.keylessData
    ) {
      try {
        updatedItem.keylessData = await encryptWithKeylessKey({
          rawData,
          encryptionKey: keylessCredential.encryptionKey,
        });
        // Use source timestamp to indicate same version, avoid "pseudo-latest"
        updatedItem.keylessDataTime = item.dataTime ?? now;
      } catch (error) {
        console.error(
          '[PrimeCloudSync] Failed to generate keylessData:',
          error,
        );
      }
    }

    // Generate OneKey ID encrypted data if targeting OneKey ID mode
    // Note: OneKey ID encryption is handled by existing flow in buildSyncItem
    // Here we just ensure rawData is set for later encryption

    return updatedItem;
  }

  /**
   * Handle mode switch: convert existing data to match new mode
   *
   * This is called when:
   * - OneKey Cloud sync is enabled/disabled
   * - Keyless wallet is created/removed
   * - Mode is detected to have changed
   *
   * @param newMode New active mode
   */
  async handleModeSwitchConversion(newMode: ECloudSyncMode): Promise<void> {
    if (newMode === ECloudSyncMode.None) {
      return;
    }

    const syncCredential = await this.getSyncCredentialSafe();
    const keylessCredential = await this.getKeylessCredential();

    // Need at least one credential to perform conversion
    if (!syncCredential && !keylessCredential) {
      return;
    }

    const { items } = await this.getAllLocalSyncItems();
    const itemsToConvert = items.filter(
      (item) => item.dataType !== EPrimeCloudSyncDataType.Lock,
    );

    if (itemsToConvert.length === 0) {
      return;
    }

    const convertedItems = await this.convertSyncItemsForModeSwitch({
      items: itemsToConvert,
      targetMode: newMode,
      syncCredential,
      keylessCredential,
    });

    // Save converted items
    const itemsNeedUpdate = convertedItems.filter((converted, index) => {
      const original = itemsToConvert[index];
      // Check if keylessData was generated
      return (
        converted.keylessData !== original.keylessData ||
        converted.rawData !== original.rawData
      );
    });

    if (itemsNeedUpdate.length > 0) {
      await localDb.addAndUpdateSyncItems({
        items: itemsNeedUpdate,
        skipUploadToServer: true, // Will upload in the sync flow
      });
      console.log(
        `[PrimeCloudSync] Mode switch conversion completed for ${itemsNeedUpdate.length} items`,
      );
    }
  }

  // ============ End of Keyless Cloud Sync Methods ============

  getSyncManager(dataType: EPrimeCloudSyncDataType) {
    switch (dataType) {
      case EPrimeCloudSyncDataType.Wallet:
        return this.syncManagers.wallet;
      case EPrimeCloudSyncDataType.Account:
        return this.syncManagers.account;
      case EPrimeCloudSyncDataType.IndexedAccount:
        return this.syncManagers.indexedAccount;
      case EPrimeCloudSyncDataType.Lock:
        return this.syncManagers.lock;
      case EPrimeCloudSyncDataType.BrowserBookmark:
        return this.syncManagers.browserBookmark;
      case EPrimeCloudSyncDataType.MarketWatchList:
        return this.syncManagers.marketWatchList;
      case EPrimeCloudSyncDataType.AddressBook:
        return this.syncManagers.addressBook;
      case EPrimeCloudSyncDataType.CustomRpc:
        return this.syncManagers.customRpc;
      case EPrimeCloudSyncDataType.CustomNetwork:
        return this.syncManagers.customNetwork;
      case EPrimeCloudSyncDataType.CustomToken:
        return this.syncManagers.customToken;
      default: {
        const exhaustiveCheck: never = dataType;
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new OneKeyLocalError(
          `Unsupported data type: ${exhaustiveCheck as string}`,
        );
      }
    }
  }

  @backgroundMethod()
  async apiFetchSyncLock() {
    // NOTE: Lock/Reset/Flush endpoints are OneKey ID only; Keyless mode never calls them.
    const client = await this.backgroundApi.servicePrime.getPrimeClient();
    // TODO return pwdHash from server
    const result = await client.get<
      IApiClientResponse<{
        lock: ICloudSyncServerItemByDownloaded;
      }>
    >('/prime/v1/sync/lock');
    console.log('prime cloud sync apiGetSyncLock: ', result?.data?.data);
    return result?.data?.data;
  }

  @backgroundMethod()
  async decodeServerLockItem({
    lockItem,
    serverUserInfo,
  }: {
    lockItem: ICloudSyncServerItemByDownloaded;
    serverUserInfo: IPrimeServerUserInfo;
  }) {
    const item = await this.convertServerItemToLocalItem({
      serverItem: lockItem,
      syncCredential: this.syncManagers.lock.getLockStaticSyncCredential({
        primeAccountSalt: serverUserInfo.salt,
        securityPasswordR1: 'lock',
        masterPasswordUUID: serverUserInfo.pwdHash,
      }),
      shouldDecrypt: true,
      serverPwdHash: serverUserInfo.pwdHash,
    });
    return item;
  }

  @backgroundMethod()
  async apiDownloadItems({
    start,
    limit,
    includeDeleted = false,
    customPwdHash,
  }: {
    start?: number;
    limit?: number;
    includeDeleted?: boolean;
    customPwdHash?: string;
  } = {}): Promise<ICloudSyncDownloadResult> {
    const postData: ICloudSyncDownloadPostData = {
      includeDeleted,
      start,
      limit,
    };

    let data: ICloudSyncDownloadResult | undefined;
    let pwdHash: string | undefined;

    if ((await this.getActiveSyncMode()) === ECloudSyncMode.Keyless) {
      data = await this.apiDownloadItemsKeyless({
        postData,
      });
    } else {
      const client = await this.backgroundApi.servicePrime.getPrimeClient();
      const { masterPasswordUUID } = await primeMasterPasswordPersistAtom.get();
      pwdHash =
        customPwdHash ||
        masterPasswordUUID ||
        RESET_CLOUD_SYNC_MASTER_PASSWORD_UUID;
      const result = await client.post<
        IApiClientResponse<ICloudSyncDownloadResult>
      >('/prime/v1/sync/download', {
        ...postData,
        pwdHash,
      });
      data = result?.data?.data;
    }

    data.pwdHash = data?.pwdHash || pwdHash || '';
    console.log('prime cloud sync apiDownloadItems: ', data);
    return data;
  }

  @backgroundMethod()
  async apiCheckServerStatus({
    localItems,
    isFullDBChecking,
  }: {
    localItems?: IDBCloudSyncItem[];
    isFullDBChecking?: boolean;
  } = {}): Promise<ICloudSyncCheckServerStatusResult> {
    const items = localItems || [];
    const onlyCheckLocalDataType = isFullDBChecking
      ? [
          EPrimeCloudSyncDataType.Lock,
          EPrimeCloudSyncDataType.Wallet,
          EPrimeCloudSyncDataType.Account,
          EPrimeCloudSyncDataType.IndexedAccount,
        ]
      : Object.values(EPrimeCloudSyncDataType);
    const postData: ICloudSyncCheckServerStatusPostData = {
      localData: items.map((item) => ({
        key: item.id,
        dataTimestamp: item.dataTime,
        dataType: item.dataType,
      })),
      onlyCheckLocalDataType,
    };

    let responseData: ICloudSyncCheckServerStatusResult | undefined;
    let masterPasswordUUID: string | undefined;
    let serverTimeStr: string | undefined;
    if ((await this.getActiveSyncMode()) === ECloudSyncMode.Keyless) {
      const result = await this.apiCheckServerStatusKeyless({
        postData,
      });
      responseData = result.result;
      serverTimeStr = result.serverTime;
    } else {
      const client = await this.backgroundApi.servicePrime.getPrimeClient();
      ({ masterPasswordUUID } = await primeMasterPasswordPersistAtom.get());
      // TODO: server needs to filter data based on the submitted localData, not all data
      const result = await client.post<
        IApiClientResponse<ICloudSyncCheckServerStatusResult>
      >('/prime/v1/sync/check', {
        ...postData,
        pwdHash: masterPasswordUUID,
      });
      responseData = result?.data?.data;
      serverTimeStr = result?.headers?.date as string | undefined;
    }

    if (!responseData.serverTime) {
      try {
        if (serverTimeStr) {
          const serverTime = new Date(serverTimeStr).getTime();
          if (
            serverTime &&
            systemTimeUtils.isTimeValid({
              time: serverTime,
            })
          ) {
            responseData.serverTime = serverTime;
          }
        }
      } catch (error) {
        console.error('prime cloud sync apiCheck: ', error);
      }
    }
    // fix localItems dataTime which is greater than server time
    if (responseData.serverTime) {
      try {
        const wrongTimeItems = localItems?.filter(
          (item) =>
            responseData.serverTime &&
            item.dataTime &&
            item.dataTime > responseData.serverTime,
        );
        if (wrongTimeItems?.length) {
          const fixItemTime = (
            item: IDBCloudSyncItem | RealmSchemaCloudSyncItem,
          ) => {
            if (
              responseData.serverTime &&
              item.dataTime &&
              item.dataTime > responseData.serverTime
            ) {
              item.dataTime = responseData.serverTime;
            }
          };
          wrongTimeItems.forEach((item) => {
            fixItemTime(item);
          });
          await localDb.updateSyncItem({
            ids: wrongTimeItems.map((item) => item.id),
            updater: (item) => {
              fixItemTime(item);
              return item;
            },
          });
        }
      } catch (error) {
        console.error('prime cloud sync apiCheck: ', error);
      }
    }

    responseData.pwdHash = responseData.pwdHash || masterPasswordUUID || '';
    console.log('prime cloud sync apiCheck: ', responseData);
    return responseData;
  }

  async buildLockItem({
    syncCredential,
    encryptedSecurityPasswordR1ForServer,
  }: {
    syncCredential: ICloudSyncCredentialForLock | undefined;
    encryptedSecurityPasswordR1ForServer: string | undefined;
  }): Promise<IDBCloudSyncItem | undefined> {
    if (!syncCredential) {
      throw new OneKeyError('syncCredential is required for build flush lock');
    }
    if (!encryptedSecurityPasswordR1ForServer) {
      throw new OneKeyError(
        'encryptedSecurityPasswordR1ForServer is required for build flush lock',
      );
    }
    const syncCredentialForLock =
      this.syncManagers.lock.getLockStaticSyncCredential(syncCredential);
    const lockItem = await this.syncManagers.lock.buildSyncItem({
      syncCredential: syncCredentialForLock,
      target: {
        targetId: 'lock',
        dataType: EPrimeCloudSyncDataType.Lock,
        encryptedSecurityPasswordR1ForServer,
      },
      dataTime: await this.timeNow(),
    });
    if (!lockItem?.data) {
      throw new OneKeyError('lockItem.data is not found');
    }
    return lockItem;
  }

  @backgroundMethod()
  async apiUploadItems({
    localItems,
    isFlush,
    isReset,
    skipPrimeStatusCheck,
    setUndefinedTimeToNow,
    syncCredential,
    encryptedSecurityPasswordR1ForServer,
    noDebounceUpload,
  }: {
    localItems: IDBCloudSyncItem[];
    isFlush?: boolean;
    isReset?: boolean;
    skipPrimeStatusCheck?: boolean;
    setUndefinedTimeToNow?: boolean;
    syncCredential?: ICloudSyncCredential | undefined;
    encryptedSecurityPasswordR1ForServer?: string;
    noDebounceUpload?: boolean;
  }) {
    const activeMode = await this.getActiveSyncMode();
    if (!skipPrimeStatusCheck) {
      await this.ensureCloudSyncIsAvailable();
    }
    // NOTE: Lock/Reset/Flush endpoints are OneKey ID only; Keyless mode never calls them.
    if (activeMode === ECloudSyncMode.Keyless && (isReset || isFlush)) {
      return undefined;
    }

    let pwdHash = '';
    let lockItem: IDBCloudSyncItem | undefined;

    if (isReset) {
      // eslint-disable-next-line no-param-reassign
      localItems = [];
      // eslint-disable-next-line no-param-reassign
      isFlush = true;
      pwdHash = '';
      lockItem = undefined;
      // pwdHash = RESET_CLOUD_SYNC_MASTER_PASSWORD_UUID; // TODO server should clear pwdHash
    } else {
      pwdHash =
        await this.backgroundApi.serviceMasterPassword.getLocalMasterPasswordUUID();

      if (isFlush) {
        // eslint-disable-next-line no-param-reassign
        syncCredential = syncCredential || (await this.getSyncCredentialSafe());
        const syncCredentialForLock = syncCredential
          ? this.syncManagers.lock.getLockStaticSyncCredential(syncCredential)
          : undefined;
        lockItem = await this.buildLockItem({
          syncCredential: syncCredentialForLock,
          encryptedSecurityPasswordR1ForServer,
        });
      }
    }

    if (isFlush) {
      return this._callApiUploadItems({
        localItems,
        isFlush: true,
        pwdHash,
        lockItem,
        setUndefinedTimeToNow,
      });
    }

    return this._callApiUploadItemsDebounceMerge({
      localItems,
      pwdHash,
      setUndefinedTimeToNow,
      noDebounceUpload,
    });
  }

  async callApiChangeLock({
    lockItem,
    pwdHash,
  }: {
    lockItem: IDBCloudSyncItem;
    pwdHash: string;
  }) {
    // NOTE: Lock/Reset/Flush endpoints are OneKey ID only; Keyless mode never calls them.
    const client = await this.backgroundApi.servicePrime.getPrimeClient();
    const lockItemToServer = this.convertLocalItemToServerItem({
      localItem: lockItem,
    });
    const result = await client.post<
      IApiClientResponse<{
        nonce: number;
        created: number;
        updated: number;
      }>
    >('/prime/v1/sync/lock', {
      lock: lockItemToServer,
      pwdHash,
    });

    return result;
  }

  _callApiUploadItems = async ({
    localItems,
    isFlush,
    lockItem,
    pwdHash,
    setUndefinedTimeToNow,
  }: {
    localItems: IDBCloudSyncItem[];
    isFlush: boolean | undefined;
    lockItem: IDBCloudSyncItem | undefined;
    pwdHash: string;
    setUndefinedTimeToNow: boolean | undefined;
  }) => {
    const now = await this.timeNow();
    const localData: ICloudSyncServerItem[] = localItems
      .map((item) => {
        let dataTimestamp = item.dataTime;
        if (setUndefinedTimeToNow && isNil(dataTimestamp)) {
          dataTimestamp = now;
        }
        const serverItem = this.convertLocalItemToServerItem({
          localItem: item,
          dataTimestamp,
        });
        if (process.env.NODE_ENV !== 'production') {
          // @ts-ignore
          serverItem.$$dataTimestampStr = new Date(
            serverItem?.dataTimestamp || 0,
          ).toLocaleString();
        }
        return serverItem;
      })
      .filter(Boolean);

    const filteredLocalData = localData.filter(
      (item) =>
        (item.data || item.isDeleted) && item.pwdHash === pwdHash && pwdHash,
    );

    // TODO save localData to DB if setUndefinedTimeToNow available

    // TODO filter out dataTime is undefined
    if (filteredLocalData.length === 0 && !isFlush) {
      return undefined;
    }

    if (isFlush) {
      // throw new OneKeyLocalError('Mock flush api error');
    }

    const lockItemToServer =
      isFlush && lockItem
        ? this.convertLocalItemToServerItem({
            localItem: lockItem,
          })
        : undefined;

    if (isFlush && lockItemToServer && !filteredLocalData.length) {
      // TODO remove server check
      filteredLocalData.push(lockItemToServer);
    }
    const postData: ICloudSyncUploadPostData = {
      localData: filteredLocalData,
      pwdHash,
      lock: lockItemToServer,
    };

    let uploadResult: ICloudSyncUploadResult | undefined;
    if ((await this.getActiveSyncMode()) === ECloudSyncMode.Keyless) {
      uploadResult = await this.apiUploadItemsKeyless({
        postData,
      });
    } else {
      const client = await this.backgroundApi.servicePrime.getPrimeClient();
      const result = await client.post<
        IApiClientResponse<ICloudSyncUploadResult>
      >(isFlush ? '/prime/v1/sync/flush' : '/prime/v1/sync/upload', {
        ...postData,
      });
      console.log('prime cloud sync apiUploadItems: ', result?.data?.data);
      uploadResult = result?.data?.data;
    }

    void this.updateLastSyncTime();

    return uploadResult;
  };

  uploadItemsToMerge: IDBCloudSyncItem[] = [];

  _callApiUploadItemsDebounceMerge({
    localItems,
    pwdHash,
    setUndefinedTimeToNow,
    noDebounceUpload,
  }: {
    localItems: IDBCloudSyncItem[];
    pwdHash: string;
    setUndefinedTimeToNow?: boolean;
    noDebounceUpload?: boolean;
  }) {
    this.uploadItemsToMerge = uniqBy(
      [...localItems, ...this.uploadItemsToMerge],
      (i: IDBCloudSyncItem) => i.id,
    );
    if (noDebounceUpload) {
      return this._callApiUploadItemsInstantly({
        pwdHash,
        setUndefinedTimeToNow,
      });
    }
    return this._callApiUploadItemsDebounced({
      pwdHash,
      setUndefinedTimeToNow,
    });
  }

  _callApiUploadItemsInstantly = async ({
    pwdHash,
    setUndefinedTimeToNow,
  }: {
    pwdHash: string;
    setUndefinedTimeToNow?: boolean;
  }) => {
    const localItems = [...this.uploadItemsToMerge];
    this.uploadItemsToMerge = [];
    if (localItems.length) {
      await this._callApiUploadItems({
        localItems,
        isFlush: false,
        lockItem: undefined,
        pwdHash,
        setUndefinedTimeToNow,
      });
    }
  };

  _callApiUploadItemsDebounced = debounce(
    this._callApiUploadItemsInstantly,
    1000,
    {
      leading: false,
      trailing: true,
    },
  );

  @backgroundMethod()
  @toastIfError()
  async resetServerData({
    skipPrimeStatusCheck,
  }: {
    skipPrimeStatusCheck?: boolean;
  } = {}) {
    await this.apiUploadItems({
      localItems: [],
      isReset: true,
      skipPrimeStatusCheck,
      encryptedSecurityPasswordR1ForServer: '',
    });
  }

  @backgroundMethod()
  async uploadAllLocalItems({
    isFlush,
    encryptedSecurityPasswordR1ForServer,
  }: {
    isFlush?: boolean;
    encryptedSecurityPasswordR1ForServer?: string;
  } = {}) {
    const localItems = (await this.getAllLocalSyncItems()).items;
    await this.apiUploadItems({
      localItems,
      isFlush,
      encryptedSecurityPasswordR1ForServer,
    });
  }

  @backgroundMethod()
  async syncToSceneByAllPendingItems() {
    if (!(await this.isCloudSyncIsAvailable())) {
      return;
    }
    const syncCredential = await this.getSyncCredentialSafe();
    if (!syncCredential) {
      return;
    }

    const { items } = await this.getAllLocalSyncItems();
    const pendingItems = items.filter((item) =>
      cloudSyncItemBuilder.canLocalItemSyncToScene({
        item,
        syncCredential,
      }),
    );
    return this.syncToSceneWithLocalSyncItems({
      items: pendingItems,
      syncCredential,
    });
  }

  // TODO mutex
  async syncToSceneWithLocalSyncItems({
    items,
    syncCredential,
  }: {
    items: IDBCloudSyncItem[];
    syncCredential: ICloudSyncCredential;
  }) {
    if (!syncCredential) {
      return;
    }
    if (!(await this.isCloudSyncIsAvailable())) {
      return;
    }
    return this._syncToSceneWithLocalSyncItems({
      items,
      syncCredential,
    });
  }

  async _syncToSceneWithLocalSyncItems({
    items,
    syncCredential,
    forceSync,
  }: {
    items: IDBCloudSyncItem[];
    syncCredential: ICloudSyncCredential | undefined;
    forceSync?: boolean;
  }) {
    const walletItems: IDBCloudSyncItem[] = [];
    const accountItems: IDBCloudSyncItem[] = [];
    const indexedAccountItems: IDBCloudSyncItem[] = [];
    const browserBookmarkItems: IDBCloudSyncItem[] = [];
    const marketWatchListItems: IDBCloudSyncItem[] = [];
    const customRpcItems: IDBCloudSyncItem[] = [];
    const customNetworkItems: IDBCloudSyncItem[] = [];
    const customTokenItems: IDBCloudSyncItem[] = [];
    const addressBookItems: IDBCloudSyncItem[] = [];

    for (const item of items) {
      switch (item.dataType) {
        case EPrimeCloudSyncDataType.Wallet:
          walletItems.push(item);
          break;
        case EPrimeCloudSyncDataType.Account:
          accountItems.push(item);
          break;
        case EPrimeCloudSyncDataType.IndexedAccount:
          indexedAccountItems.push(item);
          break;
        case EPrimeCloudSyncDataType.Lock:
          // do nothing here
          break;
        case EPrimeCloudSyncDataType.BrowserBookmark:
          browserBookmarkItems.push(item);
          break;
        case EPrimeCloudSyncDataType.MarketWatchList:
          marketWatchListItems.push(item);
          break;
        case EPrimeCloudSyncDataType.CustomRpc:
          customRpcItems.push(item);
          break;
        case EPrimeCloudSyncDataType.CustomNetwork:
          customNetworkItems.push(item);
          break;
        case EPrimeCloudSyncDataType.AddressBook:
          addressBookItems.push(item);
          break;
        case EPrimeCloudSyncDataType.CustomToken:
          customTokenItems.push(item);
          break;
        default: {
          const exhaustiveCheck: never = item.dataType;
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          throw new OneKeyLocalError(
            `Unsupported data type: ${exhaustiveCheck as unknown as string}`,
          );
        }
      }
    }

    const emitEventsStack: (() => Promise<void> | void)[] = [];

    // wallet sync
    await this.syncManagers.wallet.syncToScene({
      syncCredential,
      items: walletItems,
      forceSync,
    });
    if (walletItems?.length) {
      emitEventsStack.push(() => {
        appEventBus.emit(EAppEventBusNames.WalletUpdate, undefined);
      });
    }

    // account sync
    await this.syncManagers.account.syncToScene({
      syncCredential,
      items: accountItems,
      forceSync,
    });
    await this.syncManagers.indexedAccount.syncToScene({
      syncCredential,
      items: indexedAccountItems,
      forceSync,
    });
    if (accountItems?.length || indexedAccountItems?.length) {
      emitEventsStack.push(() => {
        appEventBus.emit(EAppEventBusNames.AccountUpdate, undefined);
      });
    }

    // browser bookmark sync
    await this.syncManagers.browserBookmark.syncToScene({
      syncCredential,
      items: browserBookmarkItems,
      forceSync,
    });
    if (browserBookmarkItems?.length) {
      emitEventsStack.push(() => {
        appEventBus.emit(EAppEventBusNames.RefreshBookmarkList, undefined);
      });
    }

    // market watch list sync
    await this.syncManagers.marketWatchList.syncToScene({
      syncCredential,
      items: marketWatchListItems,
      forceSync,
    });
    if (marketWatchListItems?.length) {
      emitEventsStack.push(() => {
        appEventBus.emit(EAppEventBusNames.RefreshMarketWatchList, undefined);
      });
    }

    // custom rpc sync
    await this.syncManagers.customRpc.syncToScene({
      syncCredential,
      items: customRpcItems,
      forceSync,
    });
    if (customRpcItems?.length) {
      emitEventsStack.push(() => {
        appEventBus.emit(EAppEventBusNames.RefreshCustomRpcList, undefined);
      });
    }

    // custom network sync
    await this.syncManagers.customNetwork.syncToScene({
      syncCredential,
      items: customNetworkItems,
      forceSync,
    });
    if (customNetworkItems?.length) {
      emitEventsStack.push(() => {
        appEventBus.emit(EAppEventBusNames.AddedCustomNetwork, undefined);
      });
    }

    // custom token sync
    await this.syncManagers.customToken.syncToScene({
      syncCredential,
      items: customTokenItems,
      forceSync,
    });
    if (customTokenItems?.length) {
      emitEventsStack.push(() => {
        appEventBus.emit(EAppEventBusNames.RefreshTokenList, undefined);
      });
    }

    // address book sync
    await this.syncManagers.addressBook.syncToScene({
      syncCredential,
      items: addressBookItems,
      forceSync,
    });
    if (addressBookItems?.length) {
      emitEventsStack.push(async () => {
        // appEventBus.emit(EAppEventBusNames.RefreshAddressBookList, undefined);
        await addressBookPersistAtom.set((prev) => ({
          ...prev,
          updateTimestamp: Date.now(),
        }));
      });
    }

    setTimeout(async () => {
      for (const fn of emitEventsStack) {
        await timerUtils.wait(100);
        await fn();
      }
    }, 1000);
  }

  async saveServerSyncItemsToLocal({
    serverItems,
    shouldSyncToScene,
    syncCredential,
    serverPwdHash,
  }: {
    serverItems: ICloudSyncServerItem[];
    shouldSyncToScene: boolean;
    syncCredential: ICloudSyncCredential | undefined;
    serverPwdHash: string;
  }) {
    const localSyncItemsPromise: Promise<IDBCloudSyncItem>[] = serverItems
      .map(async (serverItem) =>
        this.convertServerItemToLocalItem({
          serverItem,
          shouldDecrypt: false,
          syncCredential,
          serverPwdHash,
        }),
      )
      .filter(Boolean);
    const localItems: IDBCloudSyncItem[] = (
      await Promise.all(localSyncItemsPromise)
    ).filter(Boolean);

    return this.updateLocalItemsByServer({
      localItems,
      syncCredential,
      shouldSyncToScene,
    });
  }

  async saveServerDeletedItemsToLocal({
    deletedItemIds,
    shouldSyncToScene,
    syncCredential,
    serverPwdHash,
  }: {
    deletedItemIds: string[];
    shouldSyncToScene: boolean;
    syncCredential: ICloudSyncCredential | undefined;
    serverPwdHash: string;
  }) {
    const { records: items } = await localDb.getRecordsByIds({
      name: ELocalDBStoreNames.CloudSyncItem,
      ids: deletedItemIds,
    });

    await this.updateLocalItemsByServer({
      localItems: items.filter(Boolean).map((item) => {
        const newItem: IDBCloudSyncItem = {
          ...item,
          isDeleted: true,
          pwdHash: item.pwdHash || serverPwdHash,
        };
        cloudSyncItemBuilder.setDefaultPropsOfServerToLocalItem({
          localItem: newItem,
        });
        return newItem;
      }),
      syncCredential,
      shouldSyncToScene,
    });
  }

  async updateLocalItemsByServer({
    localItems,
    syncCredential,
    shouldSyncToScene,
  }: {
    localItems: IDBCloudSyncItem[];
    syncCredential: ICloudSyncCredential | undefined;
    shouldSyncToScene: boolean;
  }) {
    console.log('updateLocalItemsByServer', localItems);
    await localDb.addAndUpdateSyncItems({
      items: localItems,
      // the data is already from the server, so it doesn't need to be uploaded back to the server
      skipUploadToServer: true,
    });
    console.log('updateLocalItemsByServer sucess', localItems);

    if (shouldSyncToScene && syncCredential) {
      // we need to query from the database again, not use the localSyncItems above, because when updating, the timestamp may not be written if it does not match
      const { records: items } = await localDb.getRecordsByIds({
        name: ELocalDBStoreNames.CloudSyncItem,
        ids: localItems.map((item) => item.id),
      });
      await this.syncToSceneWithLocalSyncItems({
        items: items.filter(Boolean),
        syncCredential,
      });
      const deletedItems = items.filter(Boolean).filter((item) => {
        if (item && item.isDeleted) {
          const manager = this.getSyncManager(item.dataType);
          if (manager) {
            return manager.removeSyncItemIfServerDeleted;
          }
          return true;
        }
        return false;
      });

      if (deletedItems.length) {
        await localDb.removeCloudSyncPoolItems({
          keys: deletedItems.map((item) => item.id),
        });
      }
      void this.updateLastSyncTime();
    }
  }

  @backgroundMethod()
  @toastIfError()
  async startServerSyncFlow({
    isFlush,
    encryptedSecurityPasswordR1ForServer,
    setUndefinedTimeToNow,
    callerName,
    noDebounceUpload,
  }: Omit<IStartServerSyncFlowParams, 'throwError'> = {}) {
    await this.startServerSyncFlowSilently({
      isFlush,
      encryptedSecurityPasswordR1ForServer,
      setUndefinedTimeToNow,
      throwError: true,
      callerName,
      noDebounceUpload,
    });
  }

  @backgroundMethod()
  async startServerSyncFlowSilentlyThrottled(
    params: IStartServerSyncFlowParams = {},
  ) {
    await this._startServerSyncFlowSilentlyThrottled(params);
  }

  _startServerSyncFlowSilentlyThrottled = throttle(
    async (params: IStartServerSyncFlowParams = {}) => {
      await this.startServerSyncFlowSilently(params);
    },
    timerUtils.getTimeDurationMs({ minute: 1 }),
    {
      leading: true,
      trailing: false,
    },
  );

  @backgroundMethod()
  async startServerSyncFlowSilently({
    isFlush,
    encryptedSecurityPasswordR1ForServer,
    setUndefinedTimeToNow,
    throwError,
    callerName,
    noDebounceUpload,
  }: IStartServerSyncFlowParams = {}) {
    try {
      if (!(await this.isCloudSyncIsAvailable())) {
        return;
      }
      await this.ensureCloudSyncIsAvailable({
        callerName,
      });

      // when data is written, because the cached password is missing to encrypt, so data is undefined
      await this.fillingSyncItemsMissingDataFromRawData({
        skipUploadToServer: true, // will call server sync flow later
      });

      let { items: localItems } = await this.getAllLocalSyncItems();
      const allLocalItems = localItems;
      const totalItemsCount = allLocalItems.length;

      const pwdHash =
        await this.backgroundApi.serviceMasterPassword.getLocalMasterPasswordUUIDSafe();
      if (pwdHash) {
        localItems = allLocalItems.filter((item) => item.pwdHash === pwdHash);
        const availableItemsCount = localItems.length;
        if (availableItemsCount !== totalItemsCount && totalItemsCount > 0) {
          if (process.env.NODE_ENV !== 'production') {
            const invalidItems = allLocalItems.filter(
              (item) => item.pwdHash !== pwdHash,
            );
            console.log('invalidItems', invalidItems);
          }
          const removedItems = allLocalItems.filter(
            (item) => !item.rawData && item.pwdHash && item.pwdHash !== pwdHash,
          );
          if (removedItems.length) {
            void localDb.removeCloudSyncPoolItems({
              keys: removedItems.map((item) => item.id).filter(Boolean),
            });
          }
        }
      }
      // TODO remove pwdHash not matched items

      await this.startServerSyncFlowForItems({
        localItems,
        setUndefinedTimeToNow,
        isFlush,
        encryptedSecurityPasswordR1ForServer,
        isFullDBChecking: true,
        noDebounceUpload,
      });
    } catch (error) {
      errorUtils.autoPrintErrorIgnore(error);
      if (throwError) {
        throw error;
      }
    }

    // the server data has been downloaded, but it may not have been updated to the business scenario, so it needs to be executed again
    // checked by localSceneUpdated field
    await this.syncToSceneByAllPendingItems();

    return true;
  }

  async isCloudSyncIsAvailable() {
    try {
      await this.ensureCloudSyncIsAvailable();
      return true;
    } catch (error) {
      errorUtils.autoPrintErrorIgnore(error);
      return false;
    }
  }

  async ensureCloudSyncIsAvailable({
    callerName = '',
  }: {
    callerName?: string;
  } = {}) {
    const activeMode = await this.getActiveSyncMode();
    if (activeMode === ECloudSyncMode.Keyless) {
      return;
    }
    const devSettings = await devSettingsPersistAtom.get();
    const prime = await primePersistAtom.get();
    const primeAvailable =
      prime.isEnablePrime === true || devSettings.settings?.showPrimeTest;
    if (!primeAvailable) {
      throw new OneKeyError(`Prime DevSettings is not enabled: ${callerName}`);
    }

    const primeCloudSyncConfig = await primeCloudSyncPersistAtom.get();
    if (!primeCloudSyncConfig.isCloudSyncEnabled) {
      throw new OneKeyError(`Cloud sync is not enabled: ${callerName}`);
    }

    const isPrimeLoggedIn = await this.backgroundApi.servicePrime.isLoggedIn();
    if (!isPrimeLoggedIn) {
      throw new OneKeyError(`Prime is not logged in: ${callerName}`);
    }

    const isPrimeSubscriptionActive =
      await this.backgroundApi.servicePrime.isPrimeSubscriptionActive();
    if (!isPrimeSubscriptionActive) {
      throw new OneKeyError(`Prime subscription is not active: ${callerName}`);
    }
  }

  @backgroundMethod()
  async startServerSyncFlowForItems({
    localItems,
    isFlush,
    setUndefinedTimeToNow,
    encryptedSecurityPasswordR1ForServer,
    isFullDBChecking,
    noDebounceUpload,
  }: {
    localItems: IDBCloudSyncItem[];
    isFlush?: boolean;
    setUndefinedTimeToNow?: boolean;
    encryptedSecurityPasswordR1ForServer?: string;
    isFullDBChecking?: boolean;
    noDebounceUpload?: boolean;
  }) {
    if (!(await this.isCloudSyncIsAvailable())) {
      return;
    }

    await this.ensureCloudSyncIsAvailable();

    // TODO check passcode, syncPassword, accountSalt, isPrime are both available

    const serverStatus = await this.apiCheckServerStatus({
      localItems,
      isFullDBChecking,
    });

    const syncCredential = await this.getSyncCredentialSafe();

    // server obsoleted items, should be uploaded to server
    if (serverStatus.obsoleted.length || isFlush) {
      console.log('serverStatus.obsoleted', serverStatus.obsoleted);
      const itemsToUpload = localItems.filter((item) =>
        serverStatus.obsoleted.includes(item.id),
      );
      await this.apiUploadItems({
        localItems: itemsToUpload,
        isFlush: isFlush ?? false,
        setUndefinedTimeToNow: setUndefinedTimeToNow ?? true,
        syncCredential,
        encryptedSecurityPasswordR1ForServer,
        noDebounceUpload,
      });
    }

    // server diff items, should be compared with local items
    if (serverStatus.diff.length) {
      console.log('serverStatus.diff', serverStatus.diff);
      // TODO server returns missing data details, only key
      await this.saveServerSyncItemsToLocal({
        serverItems: serverStatus.diff,
        shouldSyncToScene: true,
        syncCredential,
        serverPwdHash: serverStatus.pwdHash,
      });
    }

    // server updated items, should be save to local
    if (serverStatus.updated.length) {
      console.log('serverStatus.updated', serverStatus.updated);
      await this.saveServerSyncItemsToLocal({
        serverItems: serverStatus.updated,
        shouldSyncToScene: true,
        syncCredential,
        serverPwdHash: serverStatus.pwdHash,
      });
    }

    // server deleted items, should be deleted from local
    if (serverStatus.deleted.length) {
      console.log('serverStatus.deleted', serverStatus.deleted);
      await this.saveServerDeletedItemsToLocal({
        deletedItemIds: serverStatus.deleted,
        shouldSyncToScene: true,
        syncCredential,
        serverPwdHash: serverStatus.pwdHash,
      });
    }
  }

  async getSyncCredentialSafe(): Promise<ICloudSyncCredential | undefined> {
    try {
      return await this.getSyncCredentialWithCache();
    } catch (error) {
      errorUtils.autoPrintErrorIgnore(error);
      return undefined;
    }
  }

  // TODO remove cache when logout, lock, change password/passcode, etc.
  getSyncCredentialWithCache = memoizee(
    async () => {
      const password =
        await this.backgroundApi.servicePassword.getCachedPassword();
      if (!password) {
        throw new OneKeyError('No password in memory');
      }

      const { masterPasswordUUID, encryptedSecurityPasswordR1 } =
        await primeMasterPasswordPersistAtom.get();
      if (!masterPasswordUUID || !encryptedSecurityPasswordR1) {
        void this.showAlertDialogIfLocalPasswordNotSet();
        throw new OneKeyError(
          'No masterPasswordUUID or encryptedSecurityPasswordR1 in atom',
        );
      }

      const securityPasswordR1Info =
        await this.backgroundApi.serviceMasterPassword.getSecurityPasswordR1InfoSafe(
          {
            passcode: password,
          },
        );
      const securityPasswordR1 = securityPasswordR1Info?.securityPasswordR1;
      const accountSalt = securityPasswordR1Info?.accountSalt;

      if (!securityPasswordR1) {
        throw new OneKeyError('Failed to decrypt securityPasswordR1');
      }
      if (!accountSalt) {
        throw new OneKeyError('Failed to get accountSalt');
      }

      return {
        primeAccountSalt: accountSalt,
        securityPasswordR1,
        masterPasswordUUID,
      };
    },
    {
      max: 1,
      maxAge: timerUtils.getTimeDurationMs({ hour: 8 }),
      promise: true,
    },
  );

  clearCachedSyncCredential() {
    return this.getSyncCredentialWithCache.clear();
  }

  @backgroundMethod()
  async setCloudSyncEnabled(
    enabled: boolean,
    {
      skipClearLocalMasterPassword,
    }: {
      skipClearLocalMasterPassword?: boolean;
    } = {},
  ) {
    if (!enabled && !skipClearLocalMasterPassword) {
      await this.backgroundApi.serviceMasterPassword.clearLocalMasterPassword({
        skipDisableCloudSync: true,
      });
    }
    await primeCloudSyncPersistAtom.set((v) => ({
      ...v,
      isCloudSyncEnabled: enabled,
    }));
  }

  @backgroundMethod()
  async updateLastSyncTime() {
    await primeCloudSyncPersistAtom.set(
      (v): IPrimeCloudSyncPersistAtomData => ({
        ...v,
        lastSyncTime: Date.now(),
      }),
    );
  }

  // TODO use jotai for Extension working
  async showMasterPasswordInvalidAlertDialog({
    shouldClearLocalMasterPassword,
    shouldDisableCloudSync,
  }: {
    shouldClearLocalMasterPassword: boolean;
    shouldDisableCloudSync: boolean;
  }) {
    const { isCloudSyncEnabled } = await primeCloudSyncPersistAtom.get();
    if (isCloudSyncEnabled) {
      const isPrimeLoggedIn =
        await this.backgroundApi.servicePrime.isLoggedIn();
      // const isPrimeSubscriptionActive =
      // await this.backgroundApi.servicePrime.isPrimeSubscriptionActive();
      if (isPrimeLoggedIn) {
        appEventBus.emit(
          EAppEventBusNames.PrimeMasterPasswordInvalid,
          undefined,
        );
        if (shouldClearLocalMasterPassword) {
          await this.backgroundApi.serviceMasterPassword.clearLocalMasterPassword(
            {
              skipDisableCloudSync: !shouldDisableCloudSync,
            },
          );
        }
        if (shouldDisableCloudSync) {
          await this.setCloudSyncEnabled(false);
        }
      }
    }
  }

  @backgroundMethod()
  async showAlertDialogIfServerPasswordChanged({
    serverUserInfo,
  }: {
    serverUserInfo: IPrimeServerUserInfo;
  }) {
    const serverPasswordUUID = serverUserInfo?.pwdHash;
    const { masterPasswordUUID } = await primeMasterPasswordPersistAtom.get();

    if (
      serverPasswordUUID &&
      masterPasswordUUID &&
      serverPasswordUUID !== RESET_CLOUD_SYNC_MASTER_PASSWORD_UUID &&
      masterPasswordUUID !== RESET_CLOUD_SYNC_MASTER_PASSWORD_UUID &&
      serverPasswordUUID !== masterPasswordUUID
    ) {
      await this.showMasterPasswordInvalidAlertDialog({
        shouldClearLocalMasterPassword: true,
        shouldDisableCloudSync: true,
      });
    }
  }

  @backgroundMethod()
  async showAlertDialogIfServerPasswordNotSet({
    serverUserInfo,
  }: {
    serverUserInfo: IPrimeServerUserInfo;
  }) {
    if (serverUserInfo.pwdHash) {
      return;
    }
    const { masterPasswordUUID, encryptedSecurityPasswordR1 } =
      await primeMasterPasswordPersistAtom.get();

    if (masterPasswordUUID && encryptedSecurityPasswordR1) {
      await this.showMasterPasswordInvalidAlertDialog({
        shouldClearLocalMasterPassword: false,
        shouldDisableCloudSync: true,
      });
    }
  }

  @backgroundMethod()
  async showAlertDialogIfLocalPasswordNotSet() {
    const { masterPasswordUUID, encryptedSecurityPasswordR1 } =
      await primeMasterPasswordPersistAtom.get();

    if (!masterPasswordUUID || !encryptedSecurityPasswordR1) {
      await this.showMasterPasswordInvalidAlertDialog({
        shouldClearLocalMasterPassword: true,
        shouldDisableCloudSync: true,
      });
    }
  }

  @backgroundMethod()
  async showAlertDialogIfLocalPasswordInvalid({
    error,
  }: {
    error: OneKeyErrorPrimeMasterPasswordInvalid;
  }) {
    if (
      error.className !==
      EOneKeyErrorClassNames.OneKeyErrorPrimeMasterPasswordInvalid
    ) {
      return;
    }
    const { masterPasswordUUID, encryptedSecurityPasswordR1 } =
      await primeMasterPasswordPersistAtom.get();

    if (masterPasswordUUID || encryptedSecurityPasswordR1) {
      await this.showMasterPasswordInvalidAlertDialog({
        shouldClearLocalMasterPassword: true,
        shouldDisableCloudSync: true,
      });
    }
  }

  async onWebSocketMasterPasswordChanged(
    payload: IPrimeConfigFlushInfo | IPrimeLockChangedInfo,
  ) {
    const { masterPasswordUUID } = await primeMasterPasswordPersistAtom.get();
    if (masterPasswordUUID && masterPasswordUUID !== payload.pwdHash) {
      await this.showAlertDialogIfLocalPasswordInvalid({
        error: new OneKeyErrorPrimeMasterPasswordInvalid(),
      });
    }
  }

  async initLocalSyncItemsDBForLegacyIndexedAccount() {
    const { indexedAccounts: allIndexedAccounts } =
      await this.backgroundApi.serviceAccount.getAllIndexedAccounts({});
    console.log('initLocalSyncItemsDBForLegacyIndexedAccount');
    const syncItemsForIndexedAccounts: IDBCloudSyncItem[] =
      await this.syncManagers.indexedAccount._buildInitSyncDBItems({
        dbRecords: allIndexedAccounts,
        syncCredential: undefined,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });
    await localDb.addAndUpdateSyncItems({
      items: syncItemsForIndexedAccounts,
      skipUploadToServer: true, // startSyncFlow() will handle uploading to server
    });
  }

  @backgroundMethod()
  async initLocalSyncItemsDB({
    syncCredential,
    password,
  }: {
    syncCredential: ICloudSyncCredential;
    password?: string;
  }) {
    if (!password) {
      // eslint-disable-next-line no-param-reassign
      ({ password } =
        await this.backgroundApi.servicePassword.promptPasswordVerify({
          reason: ALWAYS_VERIFY_PASSCODE_WHEN_CHANGE_SET_MASTER_PASSWORD
            ? EReasonForNeedPassword.Security
            : undefined,
        }));
    }

    await this.backgroundApi.serviceAccount.generateAllHdAndQrWalletsHashAndXfp(
      {
        password,
      },
    );

    await this.backgroundApi.serviceAccount.mergeDuplicateHDWallets({
      password,
    });

    const { wallets: allWallets, allDevices } =
      await this.backgroundApi.serviceAccount.getAllWallets({
        refillWalletInfo: true,
        excludeKeylessWallet: true,
      });
    // TODO only get watching or imported accounts for better performance
    const { accounts: allAccounts } =
      await this.backgroundApi.serviceAccount.getAllAccounts({});
    const { indexedAccounts: allIndexedAccounts } =
      await this.backgroundApi.serviceAccount.getAllIndexedAccounts({
        allWallets,
      });

    // TODO performance: only build missing sync items
    const syncItemsForWallets: IDBCloudSyncItem[] =
      await this.syncManagers.wallet.buildInitSyncDBItems({
        dbRecords: allWallets,
        allDevices,
        syncCredential,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });
    const syncItemsForAccounts: IDBCloudSyncItem[] =
      await this.syncManagers.account.buildInitSyncDBItems({
        dbRecords: allAccounts,
        allDevices,
        syncCredential,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });
    const syncItemsForIndexedAccounts: IDBCloudSyncItem[] =
      await this.syncManagers.indexedAccount.buildInitSyncDBItems({
        dbRecords: allIndexedAccounts,
        allDevices,
        syncCredential,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });

    const allBookmarks: IBrowserBookmark[] =
      (await this.backgroundApi.serviceDiscovery.getBrowserBookmarksWithFillingSortIndex()) ||
      [];
    const syncItemsForBookmarks: IDBCloudSyncItem[] =
      await this.syncManagers.browserBookmark.buildInitSyncDBItems({
        dbRecords: allBookmarks,
        allDevices,
        syncCredential,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });

    const allMarketWatchList: IMarketWatchListItemV2[] =
      (
        await this.backgroundApi.serviceMarketV2.getMarketWatchListWithFillingSortIndexV2()
      )?.data || [];
    const syncItemsForMarketWatchList: IDBCloudSyncItem[] =
      await this.syncManagers.marketWatchList.buildInitSyncDBItems({
        dbRecords: allMarketWatchList,
        allDevices,
        syncCredential,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });

    const allCustomRpc: IDBCustomRpc[] =
      (await this.backgroundApi.serviceCustomRpc.getAllCustomRpc()) || [];
    const syncItemsForCustomRpc: IDBCloudSyncItem[] =
      await this.syncManagers.customRpc.buildInitSyncDBItems({
        dbRecords: allCustomRpc,
        allDevices,
        syncCredential,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });

    const allCustomNetwork: IServerNetwork[] =
      (await this.backgroundApi.serviceCustomRpc.getAllCustomNetworks()) || [];
    const syncItemsForCustomNetwork: IDBCloudSyncItem[] =
      await this.syncManagers.customNetwork.buildInitSyncDBItems({
        dbRecords: allCustomNetwork,
        allDevices,
        syncCredential,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });

    let syncItemsForAddressBook: IDBCloudSyncItem[] = [];
    const { isSafe, items: safeAddressBookItems } =
      await this.backgroundApi.serviceAddressBook.getSafeRawItems({ password });
    if (isSafe && safeAddressBookItems?.length) {
      syncItemsForAddressBook =
        await this.syncManagers.addressBook.buildInitSyncDBItems({
          dbRecords: safeAddressBookItems,
          allDevices,
          syncCredential,
          // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
          initDataTime: undefined,
        });
    }

    const allHiddenTokens: ICloudSyncCustomToken[] =
      (await this.backgroundApi.serviceCustomToken.getAllHiddenTokens()) || [];
    const syncItemsForHiddenTokens: IDBCloudSyncItem[] =
      await this.syncManagers.customToken.buildInitSyncDBItems({
        dbRecords: allHiddenTokens,
        allDevices,
        syncCredential,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });

    const allCustomTokens: ICloudSyncCustomToken[] =
      (await this.backgroundApi.serviceCustomToken.getAllCustomTokens()) || [];
    const syncItemsForCustomTokens: IDBCloudSyncItem[] =
      await this.syncManagers.customToken.buildInitSyncDBItems({
        dbRecords: allCustomTokens,
        allDevices,
        syncCredential,
        // for legacy data, dateTime must be undefined, so that users can manually resolve conflicts
        initDataTime: undefined,
      });

    const totalItems = [
      ...syncItemsForWallets,
      ...syncItemsForAccounts,
      ...syncItemsForIndexedAccounts,
      ...syncItemsForBookmarks,
      ...syncItemsForMarketWatchList,
      ...syncItemsForCustomRpc,
      ...syncItemsForCustomNetwork,
      ...syncItemsForAddressBook,
      ...syncItemsForHiddenTokens,
      ...syncItemsForCustomTokens,
    ];

    // const totalItemsUniqById = uniqBy(totalItems, (item) => item.id);
    // const totalItemsUniqByDeleted = uniqBy(totalItems, (item) => item.isDeleted);

    await localDb.addAndUpdateSyncItems({
      items: totalItems,
      // as init item dataTime is undefined, server will reject the upload
      skipUploadToServer: true, // startSyncFlow() will handle uploading to server
    });

    // TODO rebuild missing item.data if needed, as data is undefined when credential is not available (prime is inactive)

    return {
      allWallets, // TODO handle same hash HD wallets
      allDevices,
      allAccounts,
      allIndexedAccounts,
    };
  }

  async fillingSyncItemsMissingDataFromRawData({
    skipUploadToServer,
  }: {
    skipUploadToServer: boolean;
  }) {
    const syncCredential = await this.getSyncCredentialSafe();
    if (!syncCredential) {
      return;
    }
    // TODO performance, use cursor to get items
    const { items } = await this.getAllLocalSyncItems();
    const itemsToUpdate: IDBCloudSyncItem[] = [];
    for (const item of items) {
      try {
        if (!item.data && item.rawData) {
          const syncManager = this.getSyncManager(item.dataType);
          const rawDataJson = item.rawData
            ? (JSON.parse(item.rawData) as ICloudSyncRawDataJson | undefined)
            : undefined;

          if (rawDataJson?.payload) {
            let target: any;
            if (item.isDeleted) {
              target = await syncManager.buildSyncTargetByPayload({
                payload: rawDataJson?.payload as any,
              });
            } else {
              target = await syncManager.buildSyncTargetByPayload({
                payload: rawDataJson?.payload as any,
              });
              // const record = await syncManager.getDBRecordBySyncPayload({
              //   payload: rawDataJson?.payload as any,
              // });
              // if (record) {
              //   target = await syncManager.buildSyncTargetByDBQuery({
              //     dbRecord: record as never,
              //   });
              // }
            }
            if (target) {
              const itemToUpdate = await syncManager.buildSyncItem({
                target: target as never,
                dataTime: item.dataTime,
                syncCredential,
                isDeleted: item.isDeleted,
              });
              if (itemToUpdate) itemsToUpdate.push(itemToUpdate);
            }
          }
        }
      } catch (error) {
        console.error('fillingSyncItemsMissingData error', error);
      }
    }
    if (itemsToUpdate.length) {
      await localDb.addAndUpdateSyncItems({
        items: itemsToUpdate,
        skipUploadToServer,
      });
    }
  }

  @backgroundMethod()
  @toastIfError()
  async enableCloudSync(): Promise<{
    success: boolean;
    isServerMasterPasswordSet?: boolean;
    encryptedSecurityPasswordR1ForServer?: string;
    serverDiffItems?: ICloudSyncServerDiffItem[];
  }> {
    if (systemTimeUtils.systemTimeStatus === ELocalSystemTimeStatus.INVALID) {
      throw new OneKeyError(
        appLocale.intl.formatMessage({
          id: ETranslations.prime_time_error_description,
        }),
      );
    }

    const isPrimeLoggedIn = await this.backgroundApi.servicePrime.isLoggedIn();
    if (!isPrimeLoggedIn) {
      throw new OneKeyError('Prime is not logged in');
    }
    const isPrimeSubscriptionActive =
      await this.backgroundApi.servicePrime.isPrimeSubscriptionActive();
    if (!isPrimeSubscriptionActive) {
      throw new OneKeyErrorPrimePaidMembershipRequired();
    }
    const { password } =
      await this.backgroundApi.servicePassword.promptPasswordVerify({
        reason: ALWAYS_VERIFY_PASSCODE_WHEN_CHANGE_SET_MASTER_PASSWORD
          ? EReasonForNeedPassword.Security
          : undefined,
        dialogProps: {
          // custom title not working
          title: 'Enable OneKey Cloud',
          description: appLocale.intl.formatMessage({
            id: ETranslations.prime_verify_passcode_enable_cloud,
          }),
        },
      });

    const { isServerMasterPasswordSet, encryptedSecurityPasswordR1ForServer } =
      await this.backgroundApi.serviceMasterPassword.setupMasterPassword({
        passcode: password,
      });

    let syncCredential: ICloudSyncCredential | undefined;

    const shouldManualResolveDiffItems = false;

    const serverStatus = await this.withDialogLoading(
      {
        // title: 'Initializing data',
        title: appLocale.intl.formatMessage({
          id: ETranslations.global_processing,
        }),
      },
      async () => {
        syncCredential = await this.getSyncCredentialSafe();
        // verify local password match with server master password
        if (!syncCredential) {
          throw new OneKeyError('Master password set failed');
        }
        await this.initLocalSyncItemsDB({ password, syncCredential });
        let status:
          | {
              deleted: string[];
              diff: ICloudSyncServerItem[];
              updated: ICloudSyncServerItem[];
              obsoleted: string[];
              pwdHash: string;
            }
          | undefined;
        if (shouldManualResolveDiffItems) {
          const { items: localItems } = await this.getAllLocalSyncItems();
          status = await this.apiCheckServerStatus({
            localItems,
            isFullDBChecking: true,
          });
        }
        await timerUtils.wait(1000);
        return status;
      },
    );

    if (shouldManualResolveDiffItems && serverStatus?.diff?.length) {
      const serverDiffItems: ICloudSyncServerDiffItem[] = [];
      for (const serverItem of serverStatus.diff) {
        const serverToLocalItem = await this.convertServerItemToLocalItem({
          serverItem,
          shouldDecrypt: true,
          syncCredential,
          serverPwdHash: serverStatus.pwdHash,
        });
        const syncManager = this.getSyncManager(serverItem.dataType);
        const localItem = await localDb.getSyncItemSafe({
          id: serverItem.key,
        });
        const serverPayload = serverToLocalItem?.rawDataJson?.payload;
        let record: IDBWallet | IDBAccount | IDBIndexedAccount | undefined;
        if (serverPayload) {
          record = await syncManager.getDBRecordBySyncPayload({
            payload: serverPayload as any,
          });
        }
        if (serverToLocalItem) {
          serverDiffItems.push({
            serverToLocalItem,
            localItem,
            serverPayload,
            record,
          });
        }
      }
      return {
        success: false,
        serverDiffItems, // require manual resolve from UI
      };
    }

    return {
      success: true,
      isServerMasterPasswordSet,
      encryptedSecurityPasswordR1ForServer,
    };
  }

  async getAllLocalSyncItems() {
    const { syncItems } = await localDb.getAllSyncItems();
    return { items: syncItems };
  }

  @backgroundMethod()
  @toastIfError()
  async decryptAllLocalSyncItems() {
    await this.getSyncCredentialWithCache();
    const { items } = await this.getAllLocalSyncItems();
    console.log('getAllLocalSyncItems: ', { localItems: items });
    const syncCredential = await this.getSyncCredentialSafe();
    const result: IDBCloudSyncItem[] = [];
    for (const item of items) {
      try {
        const decryptedData = await cloudSyncItemBuilder.decryptSyncItem({
          item,
          syncCredential,
        });
        if (decryptedData) {
          console.log(
            'decryptAllLocalSyncItems: ',
            decryptedData?.rawDataJson?.payload,
            decryptedData,
          );
        }
        result.push(decryptedData.dbItem || item);
      } catch (error) {
        result.push(item);
        console.error('decryptAllLocalSyncItems error', error, item);
      }
    }
    return result.toSorted((a, b) => a.id.localeCompare(b.id));
  }

  @backgroundMethod()
  @toastIfError()
  async clearAllLocalSyncItems() {
    await localDb.clearAllSyncItems();
  }

  convertLocalItemToServerItem({
    localItem,
    dataTimestamp,
  }: {
    localItem: IDBCloudSyncItem;
    dataTimestamp?: number;
  }): ICloudSyncServerItem | null {
    const serverItem: ICloudSyncServerItem = {
      key: localItem.id,
      dataType: localItem.dataType,
      data: localItem.data || '',
      dataTimestamp: dataTimestamp ?? localItem.dataTime,
      isDeleted: localItem.isDeleted,
      pwdHash: localItem.pwdHash,

      keylessData: localItem.keylessData,
      keylessDataTimestamp: localItem.keylessDataTime,
    };
    if (
      localItem.dataType === EPrimeCloudSyncDataType.Lock &&
      localItem.keylessData
    ) {
      return null;
    }
    return serverItem;
  }

  async convertServerItemToLocalItem({
    serverItem,
    shouldDecrypt,
    syncCredential,
    serverPwdHash,
  }: {
    serverItem: ICloudSyncServerItem;
    shouldDecrypt?: boolean; // decrypt the data to rawDataJson
    syncCredential: ICloudSyncCredential | undefined;
    serverPwdHash: string;
  }): Promise<IDBCloudSyncItem | null> {
    const localItem: IDBCloudSyncItem = {
      id: serverItem.key,
      rawKey: '',
      rawData: '',
      dataType: serverItem.dataType, // TODO return from server
      data: serverItem.data,
      dataTime: serverItem.dataTimestamp,
      isDeleted: serverItem.isDeleted,

      pwdHash: serverItem.pwdHash || serverPwdHash,

      localSceneUpdated: false, // server item
      serverUploaded: false,

      keylessData: serverItem.keylessData,
      keylessDataTime: serverItem.keylessDataTimestamp,
    };
    if (
      serverItem.keylessData &&
      serverItem.dataType === EPrimeCloudSyncDataType.Lock
    ) {
      return null;
    }
    cloudSyncItemBuilder.setDefaultPropsOfServerToLocalItem({
      localItem,
    });
    if (shouldDecrypt) {
      const decryptedItem = await cloudSyncItemBuilder.decryptSyncItem({
        item: localItem,
        syncCredential,
      });
      if (decryptedItem.dbItem) {
        return decryptedItem.dbItem;
      }
    }
    return localItem;
  }

  @backgroundMethod()
  async timeNow(): Promise<number> {
    return systemTimeUtils.getTimeNow();
  }

  @backgroundMethod()
  async getLocalSystemTimeStatus() {
    return {
      status: systemTimeUtils.systemTimeStatus,

      lastServerTime: systemTimeUtils.lastServerTime,
      lastServerTimeDate: new Date(
        systemTimeUtils.lastServerTime ?? 0,
      ).toISOString(),

      lastLocalTime: systemTimeUtils.lastLocalTime,
      lastLocalTimeDate: new Date(
        systemTimeUtils.lastLocalTime ?? 0,
      ).toISOString(),
    };
  }

  @backgroundMethod()
  @toastIfError()
  async decryptAllServerSyncItems({
    includeDeleted,
  }: {
    includeDeleted?: boolean;
  } = {}) {
    await this.getSyncCredentialWithCache();
    const { serverData: items, pwdHash } = await this.apiDownloadItems({
      includeDeleted,
    });
    const localItems: IDBCloudSyncItem[] = [];
    const syncCredential = await this.getSyncCredentialSafe();
    for (const item of items) {
      const localItem = await this.convertServerItemToLocalItem({
        serverItem: item,
        shouldDecrypt: true,
        syncCredential,
        serverPwdHash: pwdHash,
      });
      if (localItem) {
        localItems.push(localItem);
      }
      if (localItem) {
        console.log(
          'decryptAllServerSyncItems: ',
          localItem?.rawDataJson?.payload,
          localItem,
        );
      }
    }
    return localItems.toSorted((a, b) => a.id.localeCompare(b.id));
  }

  @backgroundMethodForDev()
  async demoDownloadAllServerSyncItemsAndSaveToLocal() {
    const localItems = await this.decryptAllServerSyncItems();
    await localDb.addAndUpdateSyncItems({
      items: localItems,
      skipUploadToServer: true,
    });
  }

  @backgroundMethodForDev()
  async demoCopyDevice() {
    if (process.env.NODE_ENV !== 'production') {
      const fromDeviceId = '8fe72eee-e6e5-4327-b923-517f960da17d';
      const toDeviceId = '5bb89656-571f-4d24-a2de-2f499775b7a9';
      const device = await localDb.getRecordById({
        name: ELocalDBStoreNames.Device,
        id: fromDeviceId,
      });
      await localDb.withTransaction(
        EIndexedDBBucketNames.account,
        async (tx) => {
          await localDb.txAddRecords({
            tx,
            name: ELocalDBStoreNames.Device,
            skipIfExists: true,
            records: [
              {
                ...device,
                id: toDeviceId,
              },
            ],
          });
        },
      );
    }
  }

  @backgroundMethodForDev()
  async demoClearSyncItemPwdHash() {
    const { syncItems } = await localDb.getAllSyncItems();
    await localDb.withTransaction(
      // EIndexedDBBucketNames.cloudSync,
      EIndexedDBBucketNames.account,
      async (tx) => {
        await localDb.txUpdateRecords({
          tx,
          name: ELocalDBStoreNames.CloudSyncItem,
          ids: syncItems.map((item) => item.id),
          updater: (record) => {
            record.pwdHash = '';
            return record;
          },
        });
      },
    );
  }

  @backgroundMethodForDev()
  async demoTamperingLocalSyncItemData() {
    const { syncItems } = await localDb.getAllSyncItems();
    await localDb.withTransaction(
      // EIndexedDBBucketNames.cloudSync,
      EIndexedDBBucketNames.account,
      async (tx) => {
        await localDb.txUpdateRecords({
          tx,
          name: ELocalDBStoreNames.CloudSyncItem,
          ids: syncItems.map((item) => item.id),
          updater: (record) => {
            record.data = '999999';
            record.localSceneUpdated = false;
            return record;
          },
        });
      },
    );
  }

  @backgroundMethodForDev()
  async demoTamperingLocalSyncItemDataTime() {
    const { syncItems } = await localDb.getAllSyncItems();
    await localDb.withTransaction(
      // EIndexedDBBucketNames.cloudSync,
      EIndexedDBBucketNames.account,
      async (tx) => {
        await localDb.txUpdateRecords({
          tx,
          name: ELocalDBStoreNames.CloudSyncItem,
          ids: syncItems.map((item) => item.id),
          updater: (record) => {
            record.dataTime = 2_000_000_000_000;
            return record;
          },
        });
      },
    );
  }
}

export default ServicePrimeCloudSync;

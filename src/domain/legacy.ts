import { gql } from "@apollo/client";
import { Token as UniToken } from "@uniswap/sdk-core";
import { Pool } from "@uniswap/v3-sdk";
import { BigNumber, ethers } from "ethers";
import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";

import OrderBook from "abis/OrderBook.json";
import PositionManager from "abis/PositionManager.json";
import PositionRouter from "abis/PositionRouter.json";
import Router from "abis/Router.json";
import Token from "abis/Token.json";
import UniPool from "abis/UniPool.json";
import UniswapV2 from "abis/UniswapV2.json";
import Vault from "abis/Vault.json";

import { ARBITRUM, ARBITRUM_GOERLI, AVALANCHE, HARMONY, getChainName, getConstant, getHighExecutionFee } from "config/chains";
import { getContract } from "config/contracts";
import { DECREASE, INCREASE, SWAP, USD_DECIMALS, getOrderKey } from "lib/legacy";

import { t } from "@lingui/macro";
import { getServerBaseUrl, getServerUrl } from "config/backend";
import { UI_VERSION, isDevelopment } from "config/env";
import { REQUIRED_UI_VERSION_KEY } from "config/localStorage";
import { getTokenBySymbol } from "config/tokens";
import { callContract, contractFetcher } from "lib/contracts";
import { BN_ZERO, bigNumberify, expandDecimals, parseValue } from "lib/numbers";
import { getProvider } from "lib/rpc";
import { getGmxGraphClient, nissohGraphClient } from "lib/subgraph/clients";
import { groupBy } from "lodash";
import { replaceNativeTokenAddress } from "./tokens";
import { getUsd } from "./tokens/utils";
import useWallet from "lib/wallets/useWallet";
import useSWRInfinite from "swr/infinite";

export * from "./prices";

export type PendingTransaction = {
  hash: string;
  message: string;
  messageDetails?: string;
};

export type SetPendingTransactions = Dispatch<SetStateAction<PendingTransaction[]>>;

const { AddressZero } = ethers.constants;

export function useAllOrdersStats(chainId) {
  const query = gql(`{
    orderStat(id: "total") {
      openSwap
      openIncrease
      openDecrease
      executedSwap
      executedIncrease
      executedDecrease
      cancelledSwap
      cancelledIncrease
      cancelledDecrease
    }
  }`);

  const [res, setRes] = useState<any>();

  useEffect(() => {
    const graphClient = getGmxGraphClient(chainId);
    if (graphClient) {
      // eslint-disable-next-line no-console
      graphClient.query({ query }).then(setRes).catch(console.warn);
    }
  }, [setRes, query, chainId]);

  return res ? res.data.orderStat : null;
}

export function useUserStat(chainId) {
  const query = gql(`{
    userStat(id: "total") {
      id
      uniqueCount
    }
  }`);

  const [res, setRes] = useState<any>();

  useEffect(() => {
    // eslint-disable-next-line no-console
    getGmxGraphClient(chainId)?.query({ query }).then(setRes).catch(console.warn);
  }, [setRes, query, chainId]);

  return res ? res.data.userStat : null;
}

export function useLiquidationsData(chainId, account) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (account) {
      const query = gql(`{
         liquidatedPositions(
           where: {account: "${account.toLowerCase()}"}
           first: 100
           orderBy: timestamp
           orderDirection: desc
         ) {
           key
           timestamp
           borrowFee
           loss
           collateral
           size
           markPrice
           type
         }
      }`);
      const graphClient = getGmxGraphClient(chainId);
      if (!graphClient) {
        return;
      }

      graphClient
        .query({ query })
        .then((res) => {
          const _data = res.data.liquidatedPositions.map((item) => {
            return {
              ...item,
              size: bigNumberify(item.size),
              collateral: bigNumberify(item.collateral),
              markPrice: bigNumberify(item.markPrice),
            };
          });
          setData(_data);
        })
        // eslint-disable-next-line no-console
        .catch(console.warn);
    }
  }, [setData, chainId, account]);

  return data;
}

export function useAllPositions(chainId, signer) {
  const count = 1000;
  const query = gql(`{
    aggregatedTradeOpens(
      first: ${count}
    ) {
      account
      initialPosition{
        indexToken
        collateralToken
        isLong
        sizeDelta
      }
      increaseList {
        sizeDelta
      }
      decreaseList {
        sizeDelta
      }
    }
  }`);

  const [res, setRes] = useState<any>();

  useEffect(() => {
    // eslint-disable-next-line no-console
    nissohGraphClient.query({ query }).then(setRes).catch(console.warn);
  }, [setRes, query]);

  const key = res ? `allPositions${count}__` : null;

  const { data: positions = [] } = useSWR(key, async () => {
    const provider = getProvider(signer, chainId);
    const vaultAddress = getContract(chainId, "Vault");
    const contract = new ethers.Contract(vaultAddress, Vault.abi, provider);
    const ret = await Promise.all(
      res.data.aggregatedTradeOpens.map(async (dataItem) => {
        try {
          const { indexToken, collateralToken, isLong } = dataItem.initialPosition;
          const positionData = await contract.getPosition(dataItem.account, collateralToken, indexToken, isLong);
          const position: any = {
            size: bigNumberify(positionData[0]),
            collateral: bigNumberify(positionData[1]),
            entryFundingRate: bigNumberify(positionData[3]),
            account: dataItem.account,
          };
          position.fundingFee = await contract.getFundingFee(collateralToken, position.size, position.entryFundingRate);
          position.marginFee = position.size.div(1000);
          position.fee = position.fundingFee.add(position.marginFee);

          const THRESHOLD = 5000;
          const collateralDiffPercent = position.fee.mul(10000).div(position.collateral);
          position.danger = collateralDiffPercent.gt(THRESHOLD);

          return position;
        } catch (ex) {
          // eslint-disable-next-line no-console
          console.error(ex);
        }
      })
    );

    return ret.filter(Boolean);
  });

  return positions;
}

export function useAllOrders(chainId, signer) {
  const query = gql(`{
    orders(
      first: 1000,
      orderBy: createdTimestamp,
      orderDirection: desc,
      where: {status: "open"}
    ) {
      type
      account
      index
      status
      createdTimestamp
    }
  }`);

  const [res, setRes] = useState<any>();

  useEffect(() => {
    getGmxGraphClient(chainId)?.query({ query }).then(setRes);
  }, [setRes, query, chainId]);

  const key = res ? res.data.orders.map((order) => `${order.type}-${order.account}-${order.index}`) : null;
  const { data: orders = [] } = useSWR(key, () => {
    const provider = getProvider(signer, chainId);
    const orderBookAddress = getContract(chainId, "OrderBook");
    const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, provider);
    return Promise.all(
      res.data.orders.map(async (order) => {
        try {
          const type = order.type.charAt(0).toUpperCase() + order.type.substring(1);
          const method = `get${type}Order`;
          const orderFromChain = await contract[method](order.account, order.index);
          const ret: any = {};
          for (const [key, val] of Object.entries(orderFromChain)) {
            ret[key] = val;
          }
          if (order.type === "swap") {
            ret.path = [ret.path0, ret.path1, ret.path2].filter((address) => address !== AddressZero);
          }
          ret.type = type;
          ret.index = order.index;
          ret.account = order.account;
          ret.createdTimestamp = order.createdTimestamp;
          return ret;
        } catch (ex) {
          // eslint-disable-next-line no-console
          console.error(ex);
        }
      })
    );
  });

  return orders.filter(Boolean);
}

export function usePositionsForOrders(chainId, signer, orders) {
  const key = orders ? orders.map((order) => getOrderKey(order) + "____") : null;
  const { data: positions = {} } = useSWR(key, async () => {
    const provider = getProvider(signer, chainId);
    const vaultAddress = getContract(chainId, "Vault");
    const contract = new ethers.Contract(vaultAddress, Vault.abi, provider);
    const data = await Promise.all(
      orders.map(async (order) => {
        try {
          const position = await contract.getPosition(
            order.account,
            order.collateralToken,
            order.indexToken,
            order.isLong
          );
          if (position[0].eq(0)) {
            return [null, order];
          }
          return [position, order];
        } catch (ex) {
          // eslint-disable-next-line no-console
          console.error(ex);
        }
      })
    );
    return data.reduce((memo, [position, order]) => {
      memo[getOrderKey(order)] = position;
      return memo;
    }, {});
  });

  return positions;
}

function invariant(condition, errorMsg) {
  if (!condition) {
    throw new Error(errorMsg);
  }
}

export function useTrades(chainId, account) {
  function getFetchUrl(chainId: number, account: string, afterId: string): string {
    const baseUrl = `${getServerBaseUrl(chainId)}/actions`;
    const urlItem = new URL(baseUrl);

    if (account) {
      urlItem.searchParams.append("account", account);
    }

    if (afterId) {
      urlItem.searchParams.append("after", afterId);
    }

    return urlItem.toString();
  }

  function getKey(pageIndex: number, previousPageData) {
    if (previousPageData && !previousPageData.length) return null;
    const afterId = previousPageData && previousPageData[previousPageData.length - 1].id;
    return [getFetchUrl(chainId, account, afterId), pageIndex];
  }

  const {
    data,
    mutate: updateTrades,
    size,
    setSize,
  } = useSWRInfinite(getKey, {
    dedupingInterval: 10000,
    // @ts-ignore
    fetcher: ([url]) => fetch(url).then((res) => res.json()),
  });
  const trades = data ? data.flat() : undefined;

  if (trades) {
    trades.sort((item0, item1) => {
      const data0 = item0.data;
      const data1 = item1.data;
      const time0 = parseInt(data0.timestamp);
      const time1 = parseInt(data1.timestamp);
      if (time1 > time0) {
        return 1;
      }
      if (time1 < time0) {
        return -1;
      }

      const block0 = parseInt(data0.blockNumber);
      const block1 = parseInt(data1.blockNumber);

      if (isNaN(block0) && isNaN(block1)) {
        return 0;
      }

      if (isNaN(block0)) {
        return 1;
      }

      if (isNaN(block1)) {
        return -1;
      }

      if (block1 > block0) {
        return 1;
      }

      if (block1 < block0) {
        return -1;
      }

      return 0;
    });
  }

  return { trades, updateTrades, size, setSize };
}

export function useExecutionFee(signer, active, chainId, infoTokens) {
  const positionRouterAddress = getContract(chainId, "PositionRouter");
  const nativeTokenAddress = getContract(chainId, "NATIVE_TOKEN");

  console.log(5555);

  const { data: minExecutionFee } = useSWR<BigNumber>([active, chainId, positionRouterAddress, "minExecutionFee"], {
    fetcher: contractFetcher(signer, PositionRouter) as any,
  });

  const { data: gasPrice } = useSWR<BigNumber | undefined>(["gasPrice", chainId], {
    fetcher: () => {
      return new Promise<BigNumber | undefined>(async (resolve) => {
        const provider = getProvider(signer, chainId);
        if (!provider) {
          resolve(undefined);
          return;
        }

        try {
          const gasPrice = await provider.getGasPrice();
          resolve(gasPrice);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(e);
        }
      });
    },
  });

  let multiplier;

  if (chainId === HARMONY || chainId === ARBITRUM || chainId === ARBITRUM_GOERLI) {
    multiplier = 2150000;
  }

  // multiplier for Avalanche is just the average gas usage
  if (chainId === AVALANCHE) {
    multiplier = 700000;
  }

  let finalExecutionFee = minExecutionFee;

  if (gasPrice && minExecutionFee) {
    const estimatedExecutionFee = gasPrice.mul(multiplier);
    if (estimatedExecutionFee.gt(minExecutionFee)) {
      finalExecutionFee = estimatedExecutionFee;
    }
  }

  const finalExecutionFeeUSD = getUsd(finalExecutionFee, nativeTokenAddress, false, infoTokens);
  const isFeeHigh = finalExecutionFeeUSD?.gt(expandDecimals(getHighExecutionFee(chainId), USD_DECIMALS));
  const errorMessage =
    isFeeHigh &&
    t`The network Fees are very high currently, which may be due to a temporary increase in transactions on the ${getChainName(
      chainId
    )} network.`;

  console.log('finalExecutionFee', finalExecutionFee);

  return {
    minExecutionFee: finalExecutionFee,
    minExecutionFeeUSD: finalExecutionFeeUSD,
    minExecutionFeeErrorMessage: errorMessage,
  };
}

export function useStakedGmxSupply(signer, active) {
  const gmxAddressArb = getContract(ARBITRUM, "GMX");
  const stakedGmxTrackerAddressArb = getContract(ARBITRUM, "StakedGmxTracker");

  const { data: arbData, mutate: arbMutate } = useSWR<any>(
    [`StakeV2:stakedGmxSupply:${active}`, ARBITRUM, gmxAddressArb, "balanceOf", stakedGmxTrackerAddressArb],
    {
      fetcher: contractFetcher(signer, Token),
    }
  );

  const gmxAddressAvax = getContract(AVALANCHE, "GMX");
  const stakedGmxTrackerAddressAvax = getContract(AVALANCHE, "StakedGmxTracker");

  const { data: avaxData, mutate: avaxMutate } = useSWR(
    [`StakeV2:stakedGmxSupply:${active}`, AVALANCHE, gmxAddressAvax, "balanceOf", stakedGmxTrackerAddressAvax],
    {
      fetcher: contractFetcher(undefined, Token),
    }
  );

  let data;
  if (arbData && avaxData) {
    data = arbData.add(avaxData);
  }

  const mutate = () => {
    arbMutate();
    avaxMutate();
  };

  return { data, mutate };
}

export function useHasOutdatedUi() {
  const { active } = useWallet();

  const url = getServerUrl(ARBITRUM, `/ui_version?client_version=${UI_VERSION}&active=${active}`);
  const { data, mutate } = useSWR([url], {
    // @ts-ignore
    fetcher: (url) => fetch(url).then((res) => res.text()),
  });

  let hasOutdatedUi = false;

  if (data && parseFloat(data) > parseFloat(UI_VERSION)) {
    hasOutdatedUi = true;
  }

  if (isDevelopment()) {
    const localStorageVersion = localStorage.getItem(REQUIRED_UI_VERSION_KEY);
    hasOutdatedUi = Boolean(localStorageVersion && parseFloat(localStorageVersion) > parseFloat(UI_VERSION));
  }

  return { data: hasOutdatedUi, mutate };
}

export function useGmxPrice(chainId, libraries, active) {
  const arbitrumLibrary = libraries && libraries.arbitrum ? libraries.arbitrum : undefined;
  const { data: gmxPriceFromArbitrum, mutate: mutateFromArbitrum } = useGmxPriceFromArbitrum(arbitrumLibrary, active);
  const { data: gmxPriceFromAvalanche, mutate: mutateFromAvalanche } = useGmxPriceFromAvalanche();

  const gmxPrice = chainId === ARBITRUM ? gmxPriceFromArbitrum : gmxPriceFromAvalanche;
  const mutate = useCallback(() => {
    mutateFromAvalanche();
    mutateFromArbitrum();
  }, [mutateFromAvalanche, mutateFromArbitrum]);

  return {
    gmxPrice,
    gmxPriceFromArbitrum,
    gmxPriceFromAvalanche,
    mutate,
  };
}

// use only the supply endpoint on arbitrum, it includes the supply on avalanche
export function useTotalGmxSupply() {
  const gmxSupplyUrlArbitrum = getServerUrl(ARBITRUM, "/gmx_supply");

  const { data: gmxSupply, mutate: updateGmxSupply } = useSWR(gmxSupplyUrlArbitrum, {
    // @ts-ignore
    fetcher: (url) => fetch(url).then((res) => res.text()),
  });

  return {
    total: gmxSupply ? bigNumberify(gmxSupply) : undefined,
    mutate: updateGmxSupply,
  };
}

export function useTotalGmxStaked() {
  const stakedGmxTrackerAddressArbitrum = getContract(ARBITRUM, "StakedGmxTracker");
  const stakedGmxTrackerAddressAvax = getContract(AVALANCHE, "StakedGmxTracker");
  let totalStakedGmx = useRef(BN_ZERO);
  const { data: stakedGmxSupplyArbitrum, mutate: updateStakedGmxSupplyArbitrum } = useSWR<BigNumber>(
    [
      `StakeV2:stakedGmxSupply:${ARBITRUM}`,
      ARBITRUM,
      getContract(ARBITRUM, "GMX"),
      "balanceOf",
      stakedGmxTrackerAddressArbitrum,
    ],
    {
      fetcher: contractFetcher(undefined, Token) as any,
    }
  );
  const { data: stakedGmxSupplyAvax, mutate: updateStakedGmxSupplyAvax } = useSWR<BigNumber>(
    [
      `StakeV2:stakedGmxSupply:${AVALANCHE}`,
      AVALANCHE,
      getContract(AVALANCHE, "GMX"),
      "balanceOf",
      stakedGmxTrackerAddressAvax,
    ],
    {
      fetcher: contractFetcher(undefined, Token) as any,
    }
  );

  const mutate = useCallback(() => {
    updateStakedGmxSupplyArbitrum();
    updateStakedGmxSupplyAvax();
  }, [updateStakedGmxSupplyArbitrum, updateStakedGmxSupplyAvax]);

  if (stakedGmxSupplyArbitrum && stakedGmxSupplyAvax) {
    let total = BigNumber.from(stakedGmxSupplyArbitrum).add(stakedGmxSupplyAvax);
    totalStakedGmx.current = total;
  }

  return {
    [AVALANCHE]: stakedGmxSupplyAvax,
    [ARBITRUM]: stakedGmxSupplyArbitrum,
    total: totalStakedGmx.current,
    mutate,
  };
}

export function useTotalGmxInLiquidity() {
  let poolAddressArbitrum = getContract(ARBITRUM, "UniswapGmxEthPool");
  let poolAddressAvax = getContract(AVALANCHE, "TraderJoeGmxAvaxPool");
  let totalGMX = useRef(BN_ZERO);

  const { data: gmxInLiquidityOnArbitrum, mutate: mutateGMXInLiquidityOnArbitrum } = useSWR<any>(
    [`StakeV2:gmxInLiquidity:${ARBITRUM}`, ARBITRUM, getContract(ARBITRUM, "GMX"), "balanceOf", poolAddressArbitrum],
    {
      fetcher: contractFetcher(undefined, Token),
    }
  );
  const { data: gmxInLiquidityOnAvax, mutate: mutateGMXInLiquidityOnAvax } = useSWR<any>(
    [`StakeV2:gmxInLiquidity:${AVALANCHE}`, AVALANCHE, getContract(AVALANCHE, "GMX"), "balanceOf", poolAddressAvax],
    {
      fetcher: contractFetcher(undefined, Token),
    }
  );
  const mutate = useCallback(() => {
    mutateGMXInLiquidityOnArbitrum();
    mutateGMXInLiquidityOnAvax();
  }, [mutateGMXInLiquidityOnArbitrum, mutateGMXInLiquidityOnAvax]);

  if (gmxInLiquidityOnAvax && gmxInLiquidityOnArbitrum) {
    let total = bigNumberify(gmxInLiquidityOnArbitrum)!.add(gmxInLiquidityOnAvax);
    totalGMX.current = total;
  }
  return {
    [AVALANCHE]: gmxInLiquidityOnAvax,
    [ARBITRUM]: gmxInLiquidityOnArbitrum,
    total: totalGMX.current,
    mutate,
  };
}

function useGmxPriceFromAvalanche() {
  const poolAddress = getContract(AVALANCHE, "TraderJoeGmxAvaxPool");

  const { data, mutate: updateReserves } = useSWR(["TraderJoeGmxAvaxReserves", AVALANCHE, poolAddress, "getReserves"], {
    fetcher: contractFetcher(undefined, UniswapV2),
  });
  const { _reserve0: gmxReserve, _reserve1: avaxReserve }: any = data || {};

  const vaultAddress = getContract(AVALANCHE, "Vault");
  const avaxAddress = getTokenBySymbol(AVALANCHE, "WAVAX").address;
  const { data: avaxPrice, mutate: updateAvaxPrice } = useSWR(
    [`StakeV2:avaxPrice`, AVALANCHE, vaultAddress, "getMinPrice", avaxAddress],
    {
      fetcher: contractFetcher(undefined, Vault),
    }
  );

  const PRECISION = bigNumberify(10)!.pow(18);
  let gmxPrice;
  if (avaxReserve && gmxReserve && avaxPrice) {
    gmxPrice = avaxReserve.mul(PRECISION).div(gmxReserve).mul(avaxPrice).div(PRECISION);
  }

  const mutate = useCallback(() => {
    updateReserves(undefined, true);
    updateAvaxPrice(undefined, true);
  }, [updateReserves, updateAvaxPrice]);

  return { data: gmxPrice, mutate };
}

function useGmxPriceFromArbitrum(signer, active) {
  const poolAddress = getContract(ARBITRUM, "UniswapGmxEthPool");
  const { data: uniPoolSlot0, mutate: updateUniPoolSlot0 } = useSWR<any>(
    [`StakeV2:uniPoolSlot0:${active}`, ARBITRUM, poolAddress, "slot0"],
    {
      fetcher: contractFetcher(signer, UniPool),
    }
  );

  const vaultAddress = getContract(ARBITRUM, "Vault");
  const ethAddress = getTokenBySymbol(ARBITRUM, "WETH").address;
  const { data: ethPrice, mutate: updateEthPrice } = useSWR<BigNumber>(
    [`StakeV2:ethPrice:${active}`, ARBITRUM, vaultAddress, "getMinPrice", ethAddress],
    {
      fetcher: contractFetcher(signer, Vault) as any,
    }
  );

  const gmxPrice = useMemo(() => {
    if (uniPoolSlot0 && ethPrice) {
      const tokenA = new UniToken(ARBITRUM, ethAddress, 18, "SYMBOL", "NAME");

      const gmxAddress = getContract(ARBITRUM, "GMX");
      const tokenB = new UniToken(ARBITRUM, gmxAddress, 18, "SYMBOL", "NAME");

      const pool = new Pool(
        tokenA, // tokenA
        tokenB, // tokenB
        10000, // fee
        uniPoolSlot0.sqrtPriceX96, // sqrtRatioX96
        1, // liquidity
        uniPoolSlot0.tick, // tickCurrent
        []
      );

      const poolTokenPrice = pool.priceOf(tokenB).toSignificant(6);
      const poolTokenPriceAmount = parseValue(poolTokenPrice, 18);
      return poolTokenPriceAmount?.mul(ethPrice).div(expandDecimals(1, 18));
    }
  }, [ethPrice, uniPoolSlot0, ethAddress]);

  const mutate = useCallback(() => {
    updateUniPoolSlot0(undefined, true);
    updateEthPrice(undefined, true);
  }, [updateEthPrice, updateUniPoolSlot0]);

  return { data: gmxPrice, mutate };
}

export async function approvePlugin(chainId, pluginAddress, { signer, setPendingTxns, sentMsg, failMsg }) {
  const routerAddress = getContract(chainId, "Router");
  const contract = new ethers.Contract(routerAddress, Router.abi, signer);
  return callContract(chainId, contract, "approvePlugin", [pluginAddress], {
    sentMsg,
    failMsg,
    setPendingTxns,
  });
}

export async function createSwapOrder(
  chainId,
  signer,
  path,
  amountIn,
  minOut,
  triggerRatio,
  nativeTokenAddress,
  opts: any = {}
) {
  const executionFee = getConstant(chainId, "SWAP_ORDER_EXECUTION_GAS_FEE");
  const triggerAboveThreshold = false;
  let shouldWrap = false;
  let shouldUnwrap = false;
  opts.value = executionFee;

  if (path[0] === AddressZero) {
    shouldWrap = true;
    opts.value = opts.value.add(amountIn);
  }
  if (path[path.length - 1] === AddressZero) {
    shouldUnwrap = true;
  }
  path = replaceNativeTokenAddress(path, nativeTokenAddress);

  const params = [path, amountIn, minOut, triggerRatio, triggerAboveThreshold, executionFee, shouldWrap, shouldUnwrap];

  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);

  return callContract(chainId, contract, "createSwapOrder", params, opts);
}

export async function createIncreaseOrder(
  chainId,
  signer,
  nativeTokenAddress,
  path,
  amountIn,
  indexTokenAddress,
  minOut,
  sizeDelta,
  collateralTokenAddress,
  isLong,
  triggerPrice,
  opts: any = {}
) {
  invariant(!isLong || indexTokenAddress === collateralTokenAddress, "invalid token addresses");
  invariant(indexTokenAddress !== AddressZero, "indexToken is 0");
  invariant(collateralTokenAddress !== AddressZero, "collateralToken is 0");

  const fromETH = path[0] === AddressZero;

  path = replaceNativeTokenAddress(path, nativeTokenAddress);
  const shouldWrap = fromETH;
  const triggerAboveThreshold = !isLong;
  const executionFee = getConstant(chainId, "INCREASE_ORDER_EXECUTION_GAS_FEE");

  const params = [
    path,
    amountIn,
    indexTokenAddress,
    minOut,
    sizeDelta,
    collateralTokenAddress,
    isLong,
    triggerPrice,
    triggerAboveThreshold,
    executionFee,
    shouldWrap,
  ];

  if (!opts.value) {
    opts.value = fromETH ? amountIn.add(executionFee) : executionFee;
  }

  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);

  return callContract(chainId, contract, "createIncreaseOrder", params, opts);
}

export async function createDecreaseOrder(
  chainId,
  signer,
  indexTokenAddress,
  sizeDelta,
  collateralTokenAddress,
  collateralDelta,
  isLong,
  triggerPrice,
  triggerAboveThreshold,
  opts: any = {}
) {
  invariant(!isLong || indexTokenAddress === collateralTokenAddress, "invalid token addresses");
  invariant(indexTokenAddress !== AddressZero, "indexToken is 0");
  invariant(collateralTokenAddress !== AddressZero, "collateralToken is 0");

  const executionFee = getConstant(chainId, "DECREASE_ORDER_EXECUTION_GAS_FEE");

  const params = [
    indexTokenAddress,
    sizeDelta,
    collateralTokenAddress,
    collateralDelta,
    isLong,
    triggerPrice,
    triggerAboveThreshold,
  ];
  opts.value = executionFee;
  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);

  return callContract(chainId, contract, "createDecreaseOrder", params, opts);
}

export async function cancelSwapOrder(chainId, signer, index, opts) {
  const params = [index];
  const method = "cancelSwapOrder";
  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);

  return callContract(chainId, contract, method, params, opts);
}

export async function cancelDecreaseOrder(chainId, signer, index, opts) {
  const params = [index];
  const method = "cancelDecreaseOrder";
  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);

  return callContract(chainId, contract, method, params, opts);
}

export async function cancelIncreaseOrder(chainId, signer, index, opts) {
  const params = [index];
  const method = "cancelIncreaseOrder";
  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);

  return callContract(chainId, contract, method, params, opts);
}

export function handleCancelOrder(chainId, signer, order, opts) {
  let func;
  if (order.type === SWAP) {
    func = cancelSwapOrder;
  } else if (order.type === INCREASE) {
    func = cancelIncreaseOrder;
  } else if (order.type === DECREASE) {
    func = cancelDecreaseOrder;
  }

  return func(chainId, signer, order.index, {
    successMsg: t`Order cancelled.`,
    failMsg: t`Cancel failed.`,
    sentMsg: t`Cancel submitted.`,
    pendingTxns: opts.pendingTxns,
    setPendingTxns: opts.setPendingTxns,
  });
}

export async function cancelMultipleOrders(chainId, signer, allIndexes: any[] = [], opts) {
  const ordersWithTypes = groupBy(allIndexes, (v) => v.split("-")[0]);
  function getIndexes(key) {
    if (!ordersWithTypes[key]) return;
    return ordersWithTypes[key].map((d) => d.split("-")[1]);
  }
  // params order => swap, increase, decrease
  const params = ["Swap", "Increase", "Decrease"].map((key) => getIndexes(key) || []);
  const method = "cancelMultiple";
  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);
  return callContract(chainId, contract, method, params, opts);
}

export async function updateDecreaseOrder(
  chainId,
  signer,
  index,
  collateralDelta,
  sizeDelta,
  triggerPrice,
  triggerAboveThreshold,
  opts
) {
  const params = [index, collateralDelta, sizeDelta, triggerPrice, triggerAboveThreshold];
  const method = "updateDecreaseOrder";
  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);

  return callContract(chainId, contract, method, params, opts);
}

export async function updateIncreaseOrder(
  chainId,
  signer,
  index,
  sizeDelta,
  triggerPrice,
  triggerAboveThreshold,
  opts
) {
  const params = [index, sizeDelta, triggerPrice, triggerAboveThreshold];
  const method = "updateIncreaseOrder";
  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);

  return callContract(chainId, contract, method, params, opts);
}

export async function updateSwapOrder(chainId, signer, index, minOut, triggerRatio, triggerAboveThreshold, opts) {
  const params = [index, minOut, triggerRatio, triggerAboveThreshold];
  const method = "updateSwapOrder";
  const orderBookAddress = getContract(chainId, "OrderBook");
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, signer);

  return callContract(chainId, contract, method, params, opts);
}

export async function _executeOrder(chainId, signer, method, account, index, feeReceiver, opts) {
  const params = [account, index, feeReceiver];
  const positionManagerAddress = getContract(chainId, "PositionManager");
  const contract = new ethers.Contract(positionManagerAddress, PositionManager.abi, signer);
  return callContract(chainId, contract, method, params, opts);
}

export function executeSwapOrder(chainId, signer, account, index, feeReceiver, opts) {
  return _executeOrder(chainId, signer, "executeSwapOrder", account, index, feeReceiver, opts);
}

export function executeIncreaseOrder(chainId, signer, account, index, feeReceiver, opts) {
  return _executeOrder(chainId, signer, "executeIncreaseOrder", account, index, feeReceiver, opts);
}

export function executeDecreaseOrder(chainId, signer, account, index, feeReceiver, opts) {
  return _executeOrder(chainId, signer, "executeDecreaseOrder", account, index, feeReceiver, opts);
}

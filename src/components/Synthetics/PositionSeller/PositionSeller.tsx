import { Trans, t } from "@lingui/macro";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import cx from "classnames";
import Button from "components/Button/Button";
import BuyInputSection from "components/BuyInputSection/BuyInputSection";
import ExchangeInfoRow from "components/Exchange/ExchangeInfoRow";
import ExternalLink from "components/ExternalLink/ExternalLink";
import Modal from "components/Modal/Modal";
import PercentageInput from "components/PercentageInput/PercentageInput";
import { SubaccountNavigationButton } from "components/SubaccountNavigationButton/SubaccountNavigationButton";
import Tab from "components/Tab/Tab";
import ToggleSwitch from "components/ToggleSwitch/ToggleSwitch";
import TokenSelector from "components/TokenSelector/TokenSelector";
import Tooltip from "components/Tooltip/Tooltip";
import TooltipWithPortal from "components/Tooltip/TooltipWithPortal";
import { ValueTransition } from "components/ValueTransition/ValueTransition";
import { DEFAULT_SLIPPAGE_AMOUNT, EXCESSIVE_SLIPPAGE_AMOUNT } from "config/factors";
import { convertTokenAddress } from "config/tokens";
import { useSubaccount } from "context/SubaccountContext/SubaccountContext";
import { useSyntheticsEvents } from "context/SyntheticsEvents";
import {
  useClosingPositionKeyState,
  usePositionsConstants,
  useTokensData,
  useUserReferralInfo,
} from "context/SyntheticsStateContext/hooks/globalsHooks";
import {
  usePositionSeller,
  usePositionSellerDecreaseAmount,
  usePositionSellerDecreaseAmountWithKeepLeverage,
  usePositionSellerNextPositionValuesForDecrease,
  usePositionSellerNextPositionValuesForDecreaseWithoutKeepLeverage,
  usePositionSellerPosition,
} from "context/SyntheticsStateContext/hooks/positionSellerHooks";
import { useMinCollateralFactorForPosition, useSwapRoutes } from "context/SyntheticsStateContext/hooks/tradeHooks";
import {
  useTradeboxAvailableTokensOptions,
  useTradeboxTradeFlags,
} from "context/SyntheticsStateContext/hooks/tradeboxHooks";
import { useHasOutdatedUi } from "domain/legacy";
import {
  estimateExecuteDecreaseOrderGasLimit,
  getExecutionFee,
  useGasLimits,
  useGasPrice,
} from "domain/synthetics/fees";
import useUiFeeFactor from "domain/synthetics/fees/utils/useUiFeeFactor";
import { DecreasePositionSwapType, OrderType, createDecreaseOrderTxn } from "domain/synthetics/orders";
import {
  formatAcceptablePrice,
  formatLeverage,
  formatLiquidationPrice,
  getTriggerNameByOrderType,
  willPositionCollateralBeSufficient,
} from "domain/synthetics/positions";
import { applySlippageToPrice, getMarkPrice, getSwapAmountsByFromValue, getTradeFees } from "domain/synthetics/trade";
import { useDebugExecutionPrice } from "domain/synthetics/trade/useExecutionPrice";
import { OrderOption } from "domain/synthetics/trade/usePositionSellerState";
import { usePriceImpactWarningState } from "domain/synthetics/trade/usePriceImpactWarningState";
import { getCommonError, getDecreaseError } from "domain/synthetics/trade/utils/validation";
import { getIsEquivalentTokens } from "domain/tokens";
import { BigNumber } from "ethers";
import { useChainId } from "lib/chains";
import { USD_DECIMALS } from "lib/legacy";
import {
  bigNumberify,
  formatAmount,
  formatAmountFree,
  formatDeltaUsd,
  formatPercentage,
  formatTokenAmountWithUsd,
  formatUsd,
  parseValue,
} from "lib/numbers";
import { EMPTY_ARRAY, getByKey } from "lib/objects";
import { museNeverExist } from "lib/types";
import { usePrevious } from "lib/usePrevious";
import useWallet from "lib/wallets/useWallet";
import { useCallback, useEffect, useMemo } from "react";
import { useLatest } from "react-use";
import { AcceptablePriceImpactInputRow } from "../AcceptablePriceImpactInputRow/AcceptablePriceImpactInputRow";
import { HighPriceImpactWarning } from "../HighPriceImpactWarning/HighPriceImpactWarning";
import { TradeFeesRow } from "../TradeFeesRow/TradeFeesRow";
import "./PositionSeller.scss";

export type Props = {
  setPendingTxns: (txns: any) => void;
  isHigherSlippageAllowed: boolean;
  setIsHigherSlippageAllowed: (isAllowed: boolean) => void;
  shouldDisableValidation: boolean;
};

const ORDER_OPTION_LABELS = {
  [OrderOption.Market]: t`Market`,
  [OrderOption.Trigger]: t`TP/SL`,
};

export function PositionSeller(p: Props) {
  const { setPendingTxns } = p;
  const [, setClosingPositionKey] = useClosingPositionKeyState();

  const onClose = useCallback(() => {
    setClosingPositionKey(undefined);
  }, [setClosingPositionKey]);
  const availableTokensOptions = useTradeboxAvailableTokensOptions();
  const tokensData = useTokensData();
  const { chainId } = useChainId();
  // const savedAllowedSlippage = useSavedAllowedSlippage();
  const { signer, account } = useWallet();
  const { openConnectModal } = useConnectModal();
  const { gasPrice } = useGasPrice(chainId);
  const { gasLimits } = useGasLimits(chainId);
  const { minCollateralUsd } = usePositionsConstants();
  const userReferralInfo = useUserReferralInfo();
  const { data: hasOutdatedUi } = useHasOutdatedUi();
  const uiFeeFactor = useUiFeeFactor(chainId);
  const tradeFlags = useTradeboxTradeFlags();
  const position = usePositionSellerPosition();

  const isVisible = Boolean(position);
  const prevIsVisible = usePrevious(isVisible);

  const { setPendingPosition, setPendingOrder } = useSyntheticsEvents();

  const {
    allowedSlippage,
    closeUsdInputValue,
    defaultTriggerAcceptablePriceImpactBps,
    isSubmitting,
    keepLeverage,
    orderOption,
    receiveTokenAddress,
    setAllowedSlippage,
    setCloseUsdInputValue,
    setDefaultTriggerAcceptablePriceImpactBps,
    setIsSubmitting,
    setKeepLeverage,
    setOrderOption,
    setReceiveTokenAddress,
    setSelectedTriggerAcceptablePriceImpactBps,
    setTriggerPriceInputValue,
    triggerPriceInputValue,
    resetPositionSeller,
  } = usePositionSeller();

  const triggerPrice = parseValue(triggerPriceInputValue, USD_DECIMALS);

  const isTrigger = orderOption === OrderOption.Trigger;

  const closeSizeUsd = parseValue(closeUsdInputValue || "0", USD_DECIMALS)!;
  const maxCloseSize = position?.sizeInUsd || BigNumber.from(0);

  const receiveToken = isTrigger ? position?.collateralToken : getByKey(tokensData, receiveTokenAddress);

  const minCollateralFactor = useMinCollateralFactorForPosition(position?.key);

  useEffect(() => {
    if (!isVisible) {
      resetPositionSeller();
    }
  }, [isVisible, resetPositionSeller]);

  const markPrice = position
    ? getMarkPrice({ prices: position.indexToken.prices, isLong: position.isLong, isIncrease: false })
    : undefined;

  const { findSwapPath, maxSwapLiquidity } = useSwapRoutes(position?.collateralTokenAddress, receiveTokenAddress);

  const decreaseAmounts = usePositionSellerDecreaseAmount();
  const decreaseAmountsWithKeepLeverage = usePositionSellerDecreaseAmountWithKeepLeverage();

  const leverageCheckboxDisabledByCollateral = useMemo(() => {
    if (!position) return false;
    if (!minCollateralFactor) return false;
    if (!decreaseAmountsWithKeepLeverage) return false;
    if (decreaseAmountsWithKeepLeverage.sizeDeltaUsd.gte(position.sizeInUsd)) return false;

    return !willPositionCollateralBeSufficient(
      position,
      decreaseAmountsWithKeepLeverage.collateralDeltaAmount,
      decreaseAmountsWithKeepLeverage.realizedPnl,
      minCollateralFactor
    );
  }, [decreaseAmountsWithKeepLeverage, minCollateralFactor, position]);

  const acceptablePrice = useMemo(() => {
    if (!position || !decreaseAmounts?.acceptablePrice) {
      return undefined;
    }

    if (orderOption === OrderOption.Market) {
      return applySlippageToPrice(allowedSlippage, decreaseAmounts.acceptablePrice, false, position.isLong);
    } else if (orderOption === OrderOption.Trigger) {
      return decreaseAmounts.acceptablePrice;
    } else {
      museNeverExist(orderOption);
    }
  }, [allowedSlippage, decreaseAmounts?.acceptablePrice, orderOption, position]);

  useDebugExecutionPrice(chainId, {
    skip: true,
    marketInfo: position?.marketInfo,
    sizeInUsd: position?.sizeInUsd,
    sizeInTokens: position?.sizeInTokens,
    sizeDeltaUsd: decreaseAmounts?.sizeDeltaUsd.mul(-1),
    isLong: position?.isLong,
  });

  const shouldSwap = position && receiveToken && !getIsEquivalentTokens(position.collateralToken, receiveToken);

  const swapAmounts = useMemo(() => {
    if (!shouldSwap || !receiveToken || !decreaseAmounts?.receiveTokenAmount || !position) {
      return undefined;
    }

    return getSwapAmountsByFromValue({
      tokenIn: position.collateralToken,
      tokenOut: receiveToken,
      amountIn: decreaseAmounts.receiveTokenAmount,
      isLimit: false,
      findSwapPath,
      uiFeeFactor,
    });
  }, [decreaseAmounts, findSwapPath, position, receiveToken, shouldSwap, uiFeeFactor]);

  const receiveUsd = swapAmounts?.usdOut || decreaseAmounts?.receiveUsd;
  const receiveTokenAmount = swapAmounts?.amountOut || decreaseAmounts?.receiveTokenAmount;

  const nextPositionValues = usePositionSellerNextPositionValuesForDecrease();
  const nextPositionValuesWithoutKeepLeverage = usePositionSellerNextPositionValuesForDecreaseWithoutKeepLeverage();

  const { fees, executionFee } = useMemo(() => {
    if (!position || !decreaseAmounts || !gasLimits || !tokensData || !gasPrice) {
      return {};
    }

    const swapsCount =
      (decreaseAmounts.decreaseSwapType === DecreasePositionSwapType.NoSwap ? 0 : 1) +
      (swapAmounts?.swapPathStats?.swapPath?.length || 0);

    const estimatedGas = estimateExecuteDecreaseOrderGasLimit(gasLimits, {
      swapsCount,
    });

    return {
      fees: getTradeFees({
        isIncrease: false,
        initialCollateralUsd: position.collateralUsd,
        sizeDeltaUsd: decreaseAmounts.sizeDeltaUsd,
        swapSteps: swapAmounts?.swapPathStats?.swapSteps || [],
        positionFeeUsd: decreaseAmounts.positionFeeUsd,
        swapPriceImpactDeltaUsd: swapAmounts?.swapPathStats?.totalSwapPriceImpactDeltaUsd || BigNumber.from(0),
        positionPriceImpactDeltaUsd: decreaseAmounts.positionPriceImpactDeltaUsd,
        priceImpactDiffUsd: decreaseAmounts.priceImpactDiffUsd,
        borrowingFeeUsd: decreaseAmounts.borrowingFeeUsd,
        fundingFeeUsd: decreaseAmounts.fundingFeeUsd,
        feeDiscountUsd: decreaseAmounts.feeDiscountUsd,
        swapProfitFeeUsd: decreaseAmounts.swapProfitFeeUsd,
        uiFeeFactor,
      }),
      executionFee: getExecutionFee(chainId, gasLimits, tokensData, estimatedGas, gasPrice),
    };
  }, [
    chainId,
    decreaseAmounts,
    gasLimits,
    gasPrice,
    position,
    swapAmounts?.swapPathStats?.swapPath,
    swapAmounts?.swapPathStats?.swapSteps,
    swapAmounts?.swapPathStats?.totalSwapPriceImpactDeltaUsd,
    tokensData,
    uiFeeFactor,
  ]);

  const priceImpactWarningState = usePriceImpactWarningState({
    positionPriceImpact: fees?.positionPriceImpact,
    swapPriceImpact: fees?.swapPriceImpact,
    place: "positionSeller",
    tradeFlags,
  });

  const isNotEnoughReceiveTokenLiquidity = shouldSwap ? maxSwapLiquidity?.lt(receiveUsd || 0) : false;

  const setIsHighPositionImpactAcceptedLatestRef = useLatest(priceImpactWarningState.setIsHighPositionImpactAccepted);
  const setIsHighSwapImpactAcceptedLatestRef = useLatest(priceImpactWarningState.setIsHighSwapImpactAccepted);

  useEffect(() => {
    if (isVisible) {
      setIsHighPositionImpactAcceptedLatestRef.current(false);
      setIsHighSwapImpactAcceptedLatestRef.current(false);
    }
  }, [setIsHighPositionImpactAcceptedLatestRef, setIsHighSwapImpactAcceptedLatestRef, isVisible, orderOption]);

  const error = useMemo(() => {
    if (!position) {
      return undefined;
    }

    const commonError = getCommonError({
      chainId,
      isConnected: Boolean(account),
      hasOutdatedUi,
    });

    const decreaseError = getDecreaseError({
      marketInfo: position.marketInfo,
      inputSizeUsd: closeSizeUsd,
      sizeDeltaUsd: decreaseAmounts?.sizeDeltaUsd,
      receiveToken,
      isTrigger,
      triggerPrice,
      fixedTriggerThresholdType: undefined,
      existingPosition: position,
      markPrice,
      nextPositionValues,
      isLong: position.isLong,
      isContractAccount: false,
      minCollateralUsd,
      priceImpactWarning: priceImpactWarningState,
      isNotEnoughReceiveTokenLiquidity,
    });

    if (commonError[0] || decreaseError[0]) {
      return commonError[0] || decreaseError[0];
    }

    if (isSubmitting) {
      return t`Creating Order...`;
    }
  }, [
    account,
    chainId,
    closeSizeUsd,
    decreaseAmounts?.sizeDeltaUsd,
    hasOutdatedUi,
    isNotEnoughReceiveTokenLiquidity,
    isSubmitting,
    isTrigger,
    markPrice,
    minCollateralUsd,
    nextPositionValues,
    position,
    priceImpactWarningState,
    receiveToken,
    triggerPrice,
  ]);

  const subaccount = useSubaccount(executionFee?.feeTokenAmount ?? null);

  function onSubmit() {
    if (!account) {
      openConnectModal?.();
      return;
    }

    const orderType = isTrigger ? decreaseAmounts?.triggerOrderType : OrderType.MarketDecrease;

    if (
      !tokensData ||
      !position ||
      !executionFee?.feeTokenAmount ||
      !receiveToken?.address ||
      !receiveUsd ||
      !decreaseAmounts?.acceptablePrice ||
      !signer ||
      !orderType
    ) {
      return;
    }

    setIsSubmitting(true);

    createDecreaseOrderTxn(
      chainId,
      signer,
      subaccount,
      {
        account,
        marketAddress: position.marketAddress,
        initialCollateralAddress: position.collateralTokenAddress,
        initialCollateralDeltaAmount: decreaseAmounts.collateralDeltaAmount || BigNumber.from(0),
        receiveTokenAddress: receiveToken.address,
        swapPath: swapAmounts?.swapPathStats?.swapPath || [],
        sizeDeltaUsd: decreaseAmounts.sizeDeltaUsd,
        sizeDeltaInTokens: decreaseAmounts.sizeDeltaInTokens,
        isLong: position.isLong,
        acceptablePrice: decreaseAmounts.acceptablePrice,
        triggerPrice: isTrigger ? triggerPrice : undefined,
        minOutputUsd: BigNumber.from(0),
        decreasePositionSwapType: decreaseAmounts.decreaseSwapType,
        orderType,
        referralCode: userReferralInfo?.referralCodeForTxn,
        executionFee: executionFee.feeTokenAmount,
        allowedSlippage,
        indexToken: position.indexToken,
        tokensData,
        skipSimulation: p.shouldDisableValidation,
      },
      {
        setPendingOrder,
        setPendingTxns,
        setPendingPosition,
      }
    )
      .then(onClose)
      .finally(() => setIsSubmitting(false));
  }
  useEffect(
    function resetForm() {
      if (!isVisible !== prevIsVisible) {
        setCloseUsdInputValue("");
        setIsHighPositionImpactAcceptedLatestRef.current(false);
        setIsHighSwapImpactAcceptedLatestRef.current(false);
        setTriggerPriceInputValue("");
        setReceiveTokenAddress(undefined);
        setOrderOption(OrderOption.Market);
      }
    },
    [
      isVisible,
      prevIsVisible,
      setCloseUsdInputValue,
      setIsHighPositionImpactAcceptedLatestRef,
      setIsHighSwapImpactAcceptedLatestRef,
      setOrderOption,
      setReceiveTokenAddress,
      setTriggerPriceInputValue,
    ]
  );

  useEffect(
    function initReceiveToken() {
      if (!receiveTokenAddress && position?.collateralToken?.address) {
        const convertedAddress = convertTokenAddress(chainId, position?.collateralToken.address, "native");
        setReceiveTokenAddress(convertedAddress);
      }
    },
    [chainId, position?.collateralToken, receiveTokenAddress, setReceiveTokenAddress]
  );

  useEffect(() => {
    if (isTrigger && decreaseAmounts) {
      if (
        !defaultTriggerAcceptablePriceImpactBps ||
        !defaultTriggerAcceptablePriceImpactBps.eq(decreaseAmounts.recommendedAcceptablePriceDeltaBps.abs())
      ) {
        setDefaultTriggerAcceptablePriceImpactBps(decreaseAmounts.recommendedAcceptablePriceDeltaBps.abs());
      }
    }
  }, [decreaseAmounts, defaultTriggerAcceptablePriceImpactBps, isTrigger, setDefaultTriggerAcceptablePriceImpactBps]);

  const indexPriceDecimals = position?.indexToken?.priceDecimals;
  const toToken = position?.indexToken;

  const triggerPriceRow = (
    <ExchangeInfoRow
      className="SwapBox-info-row"
      label={t`Trigger Price`}
      value={`${decreaseAmounts?.triggerThresholdType || ""} ${
        formatUsd(decreaseAmounts?.triggerPrice, {
          displayDecimals: toToken?.priceDecimals,
        }) || "-"
      }`}
    />
  );

  const allowedSlippageRow = (
    <ExchangeInfoRow
      label={
        <TooltipWithPortal
          handle={t`Allowed Slippage`}
          position="left-top"
          renderContent={() => {
            return (
              <div className="text-white">
                <Trans>
                  You can edit the default Allowed Slippage in the settings menu on the top right of the page.
                  <br />
                  <br />
                  Note that a low allowed slippage, e.g. less than{" "}
                  {formatPercentage(bigNumberify(DEFAULT_SLIPPAGE_AMOUNT), { signed: false })}, may result in failed
                  orders if prices are volatile.
                </Trans>
              </div>
            );
          }}
        />
      }
    >
      <PercentageInput
        onChange={setAllowedSlippage}
        defaultValue={allowedSlippage}
        highValue={EXCESSIVE_SLIPPAGE_AMOUNT}
        highValueWarningText={t`Slippage is too high`}
      />
    </ExchangeInfoRow>
  );

  const markPriceRow = (
    <ExchangeInfoRow
      label={t`Mark Price`}
      value={
        formatUsd(markPrice, {
          displayDecimals: indexPriceDecimals,
        }) || "-"
      }
    />
  );

  const entryPriceRow = (
    <ExchangeInfoRow
      isTop
      label={t`Entry Price`}
      value={
        formatUsd(position?.entryPrice, {
          displayDecimals: indexPriceDecimals,
        }) || "-"
      }
    />
  );

  const acceptablePriceImpactInputRow = (() => {
    if (!decreaseAmounts) {
      return;
    }

    return (
      <AcceptablePriceImpactInputRow
        notAvailable={!triggerPriceInputValue || decreaseAmounts.triggerOrderType === OrderType.StopLossDecrease}
        defaultAcceptablePriceImpactBps={defaultTriggerAcceptablePriceImpactBps}
        fees={fees}
        setSelectedAcceptablePriceImpactBps={setSelectedTriggerAcceptablePriceImpactBps}
      />
    );
  })();

  const acceptablePriceRow = (
    <ExchangeInfoRow
      label={t`Acceptable Price`}
      value={
        decreaseAmounts?.sizeDeltaUsd.gt(0)
          ? formatAcceptablePrice(acceptablePrice, {
              displayDecimals: indexPriceDecimals,
            })
          : "-"
      }
    />
  );

  const liqPriceRow = position && (
    <ExchangeInfoRow
      className="SwapBox-info-row"
      label={t`Liq. Price`}
      value={
        <ValueTransition
          from={
            formatLiquidationPrice(position.liquidationPrice, {
              displayDecimals: indexPriceDecimals,
            })!
          }
          to={
            decreaseAmounts?.isFullClose
              ? "-"
              : decreaseAmounts?.sizeDeltaUsd.gt(0)
              ? formatLiquidationPrice(nextPositionValues?.nextLiqPrice, {
                  displayDecimals: indexPriceDecimals,
                })
              : undefined
          }
        />
      }
    />
  );

  const sizeRow = (
    <ExchangeInfoRow
      isTop={true}
      label={t`Size`}
      value={<ValueTransition from={formatUsd(position?.sizeInUsd)!} to={formatUsd(nextPositionValues?.nextSizeUsd)} />}
    />
  );

  const pnlRow =
    position &&
    (isTrigger ? (
      <ExchangeInfoRow
        label={t`PnL`}
        value={
          <ValueTransition
            from={
              <>
                {formatDeltaUsd(decreaseAmounts?.estimatedPnl)} (
                {formatPercentage(decreaseAmounts?.estimatedPnlPercentage, { signed: true })})
              </>
            }
            to={
              decreaseAmounts?.sizeDeltaUsd.gt(0) ? (
                <>
                  {formatDeltaUsd(nextPositionValues?.nextPnl)} (
                  {formatPercentage(nextPositionValues?.nextPnlPercentage, { signed: true })})
                </>
              ) : undefined
            }
          />
        }
      />
    ) : (
      <ExchangeInfoRow
        label={t`PnL`}
        value={
          <ValueTransition
            from={formatDeltaUsd(position.pnl, position.pnlPercentage)}
            to={formatDeltaUsd(nextPositionValues?.nextPnl, nextPositionValues?.nextPnlPercentage)}
          />
        }
      />
    ));

  const receiveTokenRow = isTrigger ? (
    <ExchangeInfoRow
      isTop
      className="SwapBox-info-row"
      label={t`Receive`}
      value={formatTokenAmountWithUsd(
        decreaseAmounts?.receiveTokenAmount,
        decreaseAmounts?.receiveUsd,
        position?.collateralToken?.symbol,
        position?.collateralToken?.decimals
      )}
    />
  ) : (
    <ExchangeInfoRow
      isTop
      label={t`Receive`}
      className="Exchange-info-row PositionSeller-receive-row "
      value={
        receiveToken && (
          <TokenSelector
            label={t`Receive`}
            className={cx("PositionSeller-token-selector", {
              warning: isNotEnoughReceiveTokenLiquidity,
            })}
            chainId={chainId}
            showBalances={false}
            infoTokens={availableTokensOptions?.infoTokens}
            tokenAddress={receiveToken.address}
            onSelectToken={(token) => setReceiveTokenAddress(token.address)}
            tokens={availableTokensOptions?.swapTokens || EMPTY_ARRAY}
            showTokenImgInDropdown={true}
            selectedTokenLabel={
              <span className="PositionSelector-selected-receive-token">
                {formatTokenAmountWithUsd(
                  receiveTokenAmount,
                  receiveUsd,
                  receiveToken?.symbol,
                  receiveToken?.decimals,
                  {
                    fallbackToZero: true,
                  }
                )}
              </span>
            }
            extendedSortSequence={availableTokensOptions?.sortedLongAndShortTokens}
          />
        )
      }
    />
  );

  const isStopLoss = decreaseAmounts?.triggerOrderType === OrderType.StopLossDecrease;
  const keepLeverageText = (
    <Trans>Keep leverage at {position?.leverage ? formatLeverage(position.leverage) : "..."}</Trans>
  );
  const renderKeepLeverageTooltipContent = useCallback(
    () => (
      <Trans>
        Keep leverage is not available as Position exceeds Max. Allowed Leverage.{" "}
        <ExternalLink href="https://docs.gmx.io/docs/trading/v2/#max-leverage">Read more</ExternalLink>.
      </Trans>
    ),
    []
  );
  const keepLeverageTextElem = leverageCheckboxDisabledByCollateral ? (
    <TooltipWithPortal handle={keepLeverageText} renderContent={renderKeepLeverageTooltipContent} />
  ) : (
    keepLeverageText
  );

  return (
    <div className="PositionEditor PositionSeller">
      <Modal
        className="PositionSeller-modal"
        isVisible={isVisible}
        setIsVisible={onClose}
        label={
          <Trans>
            Close {position?.isLong ? t`Long` : t`Short`} {position?.indexToken?.symbol}
          </Trans>
        }
        allowContentTouchMove
      >
        <Tab
          options={Object.values(OrderOption)}
          option={orderOption}
          optionLabels={ORDER_OPTION_LABELS}
          onChange={setOrderOption}
        />
        <SubaccountNavigationButton
          executionFee={executionFee?.feeTokenAmount}
          closeConfirmationBox={onClose}
          tradeFlags={tradeFlags}
        />

        {position && (
          <>
            <div className="relative">
              <BuyInputSection
                topLeftLabel={t`Close`}
                topRightLabel={t`Max`}
                topRightValue={formatUsd(maxCloseSize)}
                inputValue={closeUsdInputValue}
                onInputValueChange={(e) => setCloseUsdInputValue(e.target.value)}
                showMaxButton={maxCloseSize?.gt(0) && !closeSizeUsd?.eq(maxCloseSize)}
                onClickMax={() => setCloseUsdInputValue(formatAmountFree(maxCloseSize, USD_DECIMALS))}
                showPercentSelector={true}
                onPercentChange={(percentage) => {
                  const formattedAmount = formatAmountFree(maxCloseSize.mul(percentage).div(100), USD_DECIMALS, 2);
                  setCloseUsdInputValue(formattedAmount);
                }}
              >
                USD
              </BuyInputSection>
            </div>
            {isTrigger && (
              <BuyInputSection
                topLeftLabel={t`Price`}
                topRightLabel={t`Mark`}
                topRightValue={formatUsd(markPrice, {
                  displayDecimals: toToken?.priceDecimals,
                })}
                onClickTopRightLabel={() => {
                  setTriggerPriceInputValue(formatAmount(markPrice, USD_DECIMALS, toToken?.priceDecimals || 2));
                }}
                inputValue={triggerPriceInputValue}
                onInputValueChange={(e) => {
                  setTriggerPriceInputValue(e.target.value);
                }}
              >
                USD
              </BuyInputSection>
            )}

            <div className="PositionEditor-info-box">
              {!decreaseAmounts?.isFullClose && (
                <>
                  <ExchangeInfoRow
                    label={t`Leverage`}
                    value={
                      decreaseAmounts?.sizeDeltaUsd.eq(position.sizeInUsd) ? (
                        "-"
                      ) : leverageCheckboxDisabledByCollateral ? (
                        <ValueTransition
                          from={formatLeverage(position.leverage)}
                          to={formatLeverage(nextPositionValuesWithoutKeepLeverage?.nextLeverage)}
                        />
                      ) : (
                        <ValueTransition
                          from={formatLeverage(position.leverage)}
                          to={formatLeverage(nextPositionValues?.nextLeverage)}
                        />
                      )
                    }
                  />

                  <div className="PositionEditor-keep-leverage-settings">
                    <ToggleSwitch
                      disabled={leverageCheckboxDisabledByCollateral}
                      isChecked={leverageCheckboxDisabledByCollateral ? false : keepLeverage ?? false}
                      setIsChecked={setKeepLeverage}
                    >
                      <span className="text-gray font-sm">{keepLeverageTextElem}</span>
                    </ToggleSwitch>
                  </div>

                  <div className="App-card-divider" />
                </>
              )}

              {isTrigger ? (
                <>
                  {!isStopLoss && (
                    <>
                      {acceptablePriceImpactInputRow}
                      <div className="App-card-divider" />
                    </>
                  )}
                  {triggerPriceRow}
                  {!isStopLoss && acceptablePriceRow}
                  {liqPriceRow}
                  {sizeRow}
                </>
              ) : (
                <>
                  {allowedSlippageRow}
                  {entryPriceRow}
                  {acceptablePriceRow}
                  {markPriceRow}
                  {liqPriceRow}
                  {sizeRow}
                </>
              )}

              {pnlRow}

              <div className="Exchange-info-row">
                <div>
                  <Tooltip
                    handle={
                      <span className="Exchange-info-label">
                        <Trans>Collateral ({position.collateralToken?.symbol})</Trans>
                      </span>
                    }
                    position="left-top"
                    renderContent={() => {
                      return <Trans>Initial Collateral (Collateral excluding Borrow and Funding Fee).</Trans>;
                    }}
                  />
                </div>
                <div className="align-right">
                  <ValueTransition
                    from={formatUsd(position?.collateralUsd)!}
                    to={formatUsd(nextPositionValues?.nextCollateralUsd)}
                  />
                </div>
              </div>

              <TradeFeesRow {...fees} executionFee={executionFee} feesType="decrease" />

              {receiveTokenRow}
            </div>

            {priceImpactWarningState.shouldShowWarning && (
              <>
                <div className="App-card-divider" />
                <HighPriceImpactWarning
                  priceImpactWarinigState={priceImpactWarningState}
                  className="PositionSeller-price-impact-warning"
                />
              </>
            )}

            <div className="Exchange-swap-button-container">
              <Button
                className="w-full"
                variant="primary-action"
                disabled={Boolean(error) && !p.shouldDisableValidation}
                onClick={onSubmit}
              >
                {error ||
                  (isTrigger
                    ? t`Create ${getTriggerNameByOrderType(decreaseAmounts?.triggerOrderType)} Order`
                    : t`Close`)}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

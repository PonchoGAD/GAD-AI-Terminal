"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PANCAKE_PAIR_ABI = exports.PANCAKE_FACTORY_ABI = exports.ERC20_ABI = exports.PANCAKE_ROUTER_ABI = exports.ADDRESSES = void 0;
exports.ADDRESSES = {
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    PANCAKESWAP_ROUTER_V2: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    PANCAKESWAP_FACTORY: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    FOUR_MEME: '0x5c952063c7fc8610FFDB798152D69F0B9550762b',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
};
// PancakeSwap V2 Router — relevant functions only
// IMPORTANT: use *SupportingFeeOnTransferTokens variants for BSC memecoins
exports.PANCAKE_ROUTER_ABI = [
    'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
    'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
    'function getAmountsIn(uint amountOut, address[] memory path) public view returns (uint[] memory amounts)',
];
exports.ERC20_ABI = [
    'function balanceOf(address account) external view returns (uint256)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function decimals() external view returns (uint8)',
    'function totalSupply() external view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)',
];
// PancakeSwap V2 Factory — for pair lookup
exports.PANCAKE_FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];
// PancakeSwap V2 Pair — for price/reserves
exports.PANCAKE_PAIR_ABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function totalSupply() external view returns (uint256)',
];

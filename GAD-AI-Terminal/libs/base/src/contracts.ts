// Base network contract addresses and minimal ABIs

export const ADDRESSES = {
  WETH:             '0x4200000000000000000000000000000000000006',
  USDC:             '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  UNISWAP_V3_ROUTER:'0x2626664c2603336E57B271c5C0b26F421741e481',
  UNISWAP_V3_QUOTER:'0x3d4e44Eb1374240CE5F1B136aa68B6a5B9Fe9B54',
  AERODROME_ROUTER: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  AERODROME_FACTORY:'0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
};

export const UNISWAP_V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)',
];

export const UNISWAP_V3_QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

export const AERODROME_ROUTER_ABI = [
  'function swapExactETHForTokens(uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) returns (uint256[] amounts)',
  'function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)',
];

export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// Pool fee tiers for Uniswap V3
// ULTRA (1%) is most common for new meme tokens; HIGH/MEDIUM/LOW for established pairs
export const FEE_TIERS = {
  LOW:    100,   // 0.01%
  MEDIUM: 500,   // 0.05%
  HIGH:   3000,  // 0.3%
  ULTRA:  10000, // 1%
};

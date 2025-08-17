import type { Plugin } from '@elizaos/core';
import {
  type Action,
  type ActionResult,
  type Content,
  type GenerateTextParams,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Provider,
  type ProviderResult,
  Service,
  type State,
  logger,
  type MessagePayload,
  type WorldPayload,
  EventType,
} from '@elizaos/core';
import { z } from 'zod';
import { Symphony } from "symphony-sdk/viem";
import { 
  createWalletClient, 
  createPublicClient, 
  http, 
  parseEther, 
  formatEther,
  type Address,
  type WalletClient,
  type PublicClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Account } from 'viem';

// Define SEI mainnet chain configuration
const seiMainnet = {
  id: 1329,
  name: 'SEI',
  network: 'sei-mainnet',
  nativeCurrency: {
    decimals: 18,
    name: 'SEI',
    symbol: 'SEI',
  },
  rpcUrls: {
    default: { http: ['https://evm-rpc.sei-apis.com'] },
    public: { http: ['https://evm-rpc.sei-apis.com'] },
  },
  blockExplorers: {
    default: { name: 'SEI Explorer', url: 'https://seitrace.com' },
  },
} as const;

/**
 * Defines the configuration schema for the SEI swap plugin
 */
const configSchema = z.object({
  PRIVATE_KEY: z.string().min(1, 'Private key is required'),
  RPC_URL: z.string().url().default('https://evm-rpc.sei-apis.com'),
  SLIPPAGE_TOLERANCE: z.string().default('1.0'),
});

/**
 * Interface for swap data
 */
interface SwapData {
  fromToken: string;
  toToken: string;
  amountIn: string;
  amountOut: string;
  transactionHash: string;
  route: any;
}

/**
 * Interface for token information
 */
interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
}

/**
 * SEI Swap Service to handle token swapping functionality
 */
export class SeiSwapService extends Service {
  static override serviceType = 'sei-swap';

  override capabilityDescription =
    'Provides SEI token swapping functionality using Symphony protocol with proper balance checks and approvals.';

  private symphony: Symphony;
  private walletClient: WalletClient;
  private publicClient: PublicClient;
  private account: Account;
  private rpcUrl: string;
  private slippageTolerance: string;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.rpcUrl = process.env.RPC_URL || 'https://evm-rpc.sei-apis.com';
    this.slippageTolerance = process.env.SLIPPAGE_TOLERANCE || '1.0';
    
    // Initialize wallet client with private key
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('PRIVATE_KEY environment variable is required');
    }
    
    this.account = privateKeyToAccount(privateKey as `0x${string}`);
    
    // Initialize clients
    this.walletClient = createWalletClient({
      account: this.account,
      chain: seiMainnet,
      transport: http(this.rpcUrl),
    });

    this.publicClient = createPublicClient({
      chain: seiMainnet,
      transport: http(this.rpcUrl),
    });
    
    // Initialize Symphony with wallet client - following sei-agent-kit pattern
    this.symphony = new Symphony({ walletClient: this.walletClient });
    this.symphony.connectWalletClient(this.walletClient);
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info('Starting SEI swap service');
    return new SeiSwapService(runtime);
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('Stopping SEI swap service');
    const service = runtime.getService(SeiSwapService.serviceType);
    if (!service) {
      throw new Error('SEI swap service not found');
    }
    if ('stop' in service && typeof service.stop === 'function') {
      await service.stop();
    }
  }

  override async stop(): Promise<void> {
    logger.info('SEI swap service stopped');
  }

  /**
   * Gets available tokens for swapping
   */
  getAvailableTokens(): Record<string, TokenInfo> {
    // Get native address from Symphony config
    const config = this.symphony.getConfig();
    
    return {
      sei: {
        address: config.nativeAddress as Address, // Native SEI
        symbol: 'SEI',
        decimals: 18,
        name: 'SEI'
      },
      // Add other mainnet tokens - these are examples, replace with actual addresses
      usdc: {
        address: '0x3894085ef7ff0f0aedf52e2a2704928d1ec074f1' as Address, // Example USDC address
        symbol: 'USDC',
        decimals: 6,
        name: 'USD Coin'
      },
      usdt: {
        address: '0x1234567890123456789012345678901234567890' as Address, // Example USDT address
        symbol: 'USDT', 
        decimals: 6,
        name: 'Tether USD'
      }
      // Add more tokens as needed
    };
  }

  /**
   * Gets token balance following sei-agent-kit pattern
   */
  async getTokenBalance(tokenAddress: Address): Promise<string> {
    try {
      logger.info(`Querying balance of ${tokenAddress} for ${this.account.address}...`);
      
      const config = this.symphony.getConfig();
      
      // For native SEI, use getBalance
      if (tokenAddress === config.nativeAddress || tokenAddress === '0x0') {
        const balance = await this.publicClient.getBalance({ 
          address: this.account.address 
        });
        return formatEther(balance);
      }
      
      // For ERC20 tokens, read contract
      const balance = await this.publicClient.readContract({
        address: tokenAddress,
        abi: [
          {
            name: 'balanceOf',
            type: 'function',
            inputs: [{ name: 'account', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }],
            stateMutability: 'view',
          },
        ],
        functionName: 'balanceOf',
        args: [this.account.address],
      });
      
      // Get token decimals
      const decimals = await this.publicClient.readContract({
        address: tokenAddress,
        abi: [
          {
            name: 'decimals',
            type: 'function',
            inputs: [],
            outputs: [{ name: '', type: 'uint8' }],
            stateMutability: 'view',
          },
        ],
        functionName: 'decimals',
      });
      
      // Format balance with proper decimals
      const divisor = BigInt(10 ** Number(decimals));
      const formattedBalance = Number(balance as bigint) / Number(divisor);
      
      return formattedBalance.toString();
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to get token balance');
      throw new Error(`Failed to get token balance: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Checks if user has sufficient balance - following sei-agent-kit pattern
   */
  async checkSufficientBalance(tokenAddress: Address, amount: string): Promise<boolean> {
    try {
      const balance = await this.getTokenBalance(tokenAddress);
      const hasBalance = Number(balance) >= Number(amount);
      
      if (!hasBalance) {
        logger.warn(`Insufficient balance. Required: ${amount}, Available: ${balance}`);
      }
      
      return hasBalance;
    } catch (error) {
      logger.error({ error }, 'Failed to check balance');
      return false;
    }
  }

  /**
   * Gets a swap route
   */
  async getSwapRoute(fromToken: Address, toToken: Address, amountIn: string): Promise<any> {
    try {
      logger.info(`Getting swap route: ${amountIn} ${fromToken} -> ${toToken}`);
      
      // Check sufficient balance first
      const hasSufficientBalance = await this.checkSufficientBalance(fromToken, amountIn);
      if (!hasSufficientBalance) {
        throw new Error("Insufficient balance");
      }
      
      const route = await this.symphony.getRoute(
        fromToken,
        toToken,
        amountIn
      );
      
      return route;
    } catch (error) {
      logger.error({ error }, 'Failed to get swap route');
      throw new Error(`Failed to get swap route: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Executes a swap following sei-agent-kit pattern with proper approvals
   */
  async executeSwap(fromToken: Address, toToken: Address, amountIn: string, slippageAmount?: string): Promise<SwapData> {
    try {
      logger.info(`Executing swap: ${amountIn} ${fromToken} -> ${toToken}`);
      
      // Get the route for the swap
      const route = await this.getSwapRoute(fromToken, toToken, amountIn);
      
      // Check if approval is needed (following sei-agent-kit pattern)
      const isApproved = await route.checkApproval();
      if (!isApproved) {
        logger.info('Approval required, giving approval...');
        await route.giveApproval();
      }

      // Execute the swap
      const { swapReceipt } = await route.swap({
        slippage: {
          slippageAmount: slippageAmount || this.slippageTolerance,
        }
      });

      const swapData: SwapData = {
        fromToken: route.tokenIn,
        toToken: route.tokenOut,
        amountIn: route.amountInFormatted || amountIn,
        amountOut: route.amountOutFormatted || '0',
        transactionHash: swapReceipt.transactionHash,
        route: route
      };

      logger.info(`Swap successful: ${swapData.transactionHash}`);
      return swapData;
    } catch (error) {
      logger.error({ error }, 'Failed to execute swap');
      
      // Return error in same format as sei-agent-kit
      if (error instanceof Error && error.message.includes("Insufficient balance")) {
        throw new Error("Insufficient balance");
      }
      
      throw new Error(`Failed to execute swap: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Parse token from text input
   */
  parseTokenFromText(text: string, availableTokens: Record<string, TokenInfo>): { token: TokenInfo | null, symbol: string } {
    const lowerText = text.toLowerCase();
    
    for (const [key, tokenInfo] of Object.entries(availableTokens)) {
      if (lowerText.includes(tokenInfo.symbol.toLowerCase()) || 
          lowerText.includes(tokenInfo.name.toLowerCase()) ||
          lowerText.includes(key.toLowerCase())) {
        return { token: tokenInfo, symbol: tokenInfo.symbol };
      }
    }
    
    return { token: null, symbol: '' };
  }

  /**
   * Parse amount from text input
   */
  parseAmountFromText(text: string): string {
    const amountMatch = text.match(/(\d+(?:\.\d+)?)/);
    return amountMatch ? amountMatch[1] : '1.0';
  }
}

const swapSeiAction: Action = {
  name: 'SWAP_SEI',
  similes: ['SWAP_TOKENS', 'EXCHANGE_TOKENS', 'TRADE_TOKENS', 'CONVERT_TOKENS'],
  description: 'Swaps SEI tokens using Symphony protocol with proper balance checks and approvals',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return text.includes('swap') || 
           text.includes('exchange') || 
           text.includes('trade') ||
           text.includes('convert');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      if (!message.content.text) {
        return {
          success: false,
          error: new Error('Message content text is undefined'),
          text: 'I need a message with text to process your swap request.',
        };
      }

      const service = runtime.getService(SeiSwapService.serviceType) as SeiSwapService;
      if (!service) {
        throw new Error('SEI swap service not available');
      }

      const text = message.content.text.toLowerCase();
      const availableTokens = service.getAvailableTokens();
      
      // Parse amount
      const amount = service.parseAmountFromText(text);
      
      // Parse tokens - try to detect "from" and "to" tokens
      let fromToken = availableTokens.sei; // Default to SEI
      let toToken = availableTokens.usdc; // Default to USDC
      
      // Look for patterns like "swap X SEI to USDC" or "trade SEI for USDT"
      const swapPattern = /swap\s+[\d.]+\s+(\w+)\s+(?:to|for)\s+(\w+)/i;
      const tradePattern = /trade\s+[\d.]+\s+(\w+)\s+(?:to|for)\s+(\w+)/i;
      const convertPattern = /convert\s+[\d.]+\s+(\w+)\s+(?:to|for)\s+(\w+)/i;
      
      const match = text.match(swapPattern) || text.match(tradePattern) || text.match(convertPattern);
      
      if (match) {
        const fromSymbol = match[1].toLowerCase();
        const toSymbol = match[2].toLowerCase();
        
        // Find tokens by symbol
        const fromTokenFound = Object.values(availableTokens).find(t => 
          t.symbol.toLowerCase() === fromSymbol
        );
        const toTokenFound = Object.values(availableTokens).find(t => 
          t.symbol.toLowerCase() === toSymbol
        );
        
        if (fromTokenFound) fromToken = fromTokenFound;
        if (toTokenFound) toToken = toTokenFound;
      }

      // Execute swap
      const swapResult = await service.executeSwap(
        fromToken.address,
        toToken.address,
        amount,
        process.env.SLIPPAGE_TOLERANCE || '1'
      );

      const response = `✅ Successfully swapped ${swapResult.amountIn} ${fromToken.symbol} to ${swapResult.amountOut} ${toToken.symbol}\n\n🔗 Transaction: ${swapResult.transactionHash}`;

      if (callback) {
        await callback({
          text: response,
          actions: ['SWAP_SEI'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['SWAP_SEI'],
          source: message.content.source,
          swapResult,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to execute swap';
      logger.error({ error }, 'Swap action failed');
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: `❌ Sorry, I couldn't execute the swap. ${errorMessage}`,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Swap 1 SEI to USDC',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✅ Successfully swapped 1.0 SEI to 0.95 USDC\n\n🔗 Transaction: 0x1234...',
          actions: ['SWAP_SEI'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Trade 5 SEI for USDT',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✅ Successfully swapped 5.0 SEI to 4.75 USDT\n\n🔗 Transaction: 0x5678...',
          actions: ['SWAP_SEI'],
        },
      },
    ],
  ],
};

const getBalanceAction: Action = {
  name: 'GET_TOKEN_BALANCE',
  similes: ['CHECK_BALANCE', 'BALANCE', 'TOKEN_BALANCE', 'WALLET_BALANCE'],
  description: 'Gets the balance of specified tokens with proper formatting',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return text.includes('balance') || 
           text.includes('check balance') || 
           text.includes('how much') ||
           text.includes('wallet');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService(SeiSwapService.serviceType) as SeiSwapService;
      if (!service) {
        throw new Error('SEI swap service not available');
      }

      const tokens = service.getAvailableTokens();
      const balances: Record<string, string> = {};
      
      // Get balances for all available tokens
      for (const [key, tokenInfo] of Object.entries(tokens)) {
        try {
          balances[tokenInfo.symbol] = await service.getTokenBalance(tokenInfo.address);
        } catch (error) {
          logger.warn(`Failed to get balance for ${tokenInfo.symbol}: ${error}`);
          balances[tokenInfo.symbol] = '0';
        }
      }

      const response = `💰 **Your Token Balances:**\n${Object.entries(balances)
        .map(([symbol, balance]) => `• ${symbol}: ${Number(balance).toFixed(4)}`)
        .join('\n')}`;

      if (callback) {
        await callback({
          text: response,
          actions: ['GET_TOKEN_BALANCE'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['GET_TOKEN_BALANCE'],
          source: message.content.source,
          balances,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to get balances';
      logger.error({ error }, 'Balance check failed');
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: `❌ Sorry, I couldn't get your balances. ${errorMessage}`,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Check my token balances',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '💰 **Your Token Balances:**\n• SEI: 10.5000\n• USDC: 25.0000\n• USDT: 15.2500',
          actions: ['GET_TOKEN_BALANCE'],
        },
      },
    ],
  ],
};

export const seiSwapPlugin: Plugin = {
  name: 'plugin-sei-swap',
  description: 'Provides SEI token swapping functionality using Symphony protocol with proper balance checks and approvals',
  config: {
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    RPC_URL: process.env.RPC_URL,
    SLIPPAGE_TOLERANCE: process.env.SLIPPAGE_TOLERANCE,
  },
  async init(config: Record<string, string>) {
    logger.info('Initializing plugin-sei-swap');
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  },
  models: {
    [ModelType.TEXT_SMALL]: async (
      _runtime,
      { prompt, stopSequences = [] }: GenerateTextParams
    ) => {
      return 'I can help you swap SEI tokens using Symphony protocol with proper balance checks and approvals.';
    },
    [ModelType.TEXT_LARGE]: async (
      _runtime,
      {
        prompt,
        stopSequences = [],
        maxTokens = 8192,
        temperature = 0.7,
        frequencyPenalty = 0.7,
        presencePenalty = 0.7,
      }: GenerateTextParams
    ) => {
      return 'I specialize in SEI token swapping using the Symphony protocol. I can swap between SEI, USDC, USDT and other supported tokens. I always check balances before swapping and handle approvals automatically. You can ask me to swap tokens, check balances, or get swap routes.';
    },
  },
  routes: [
    {
      name: 'api-swap-route',
      path: '/api/swap/route',
      type: 'GET',
      handler: async (req: any, res: any) => {
        try {
          const { fromToken, toToken, amountIn } = req.query;
          
          if (!fromToken || !toToken || !amountIn) {
            return res.status(400).json({ 
              error: 'fromToken, toToken, and amountIn parameters are required' 
            });
          }

          const service = req.runtime.getService(SeiSwapService.serviceType) as SeiSwapService;
          if (!service) {
            return res.status(500).json({ error: 'SEI swap service not available' });
          }

          const route = await service.getSwapRoute(fromToken, toToken, amountIn);
          res.json(route);
        } catch (error) {
          res.status(500).json({
            error: 'Failed to get swap route',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'api-swap-execute',
      path: '/api/swap/execute',
      type: 'POST',
      handler: async (req: any, res: any) => {
        try {
          const { fromToken, toToken, amountIn, slippageAmount } = req.body;
          
          if (!fromToken || !toToken || !amountIn) {
            return res.status(400).json({ error: 'fromToken, toToken, and amountIn are required' });
          }

          const service = req.runtime.getService(SeiSwapService.serviceType) as SeiSwapService;
          if (!service) {
            return res.status(500).json({ error: 'SEI swap service not available' });
          }

          const swapResult = await service.executeSwap(fromToken, toToken, amountIn, slippageAmount);
          res.json(swapResult);
        } catch (error) {
          res.status(500).json({
            error: 'Failed to execute swap',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'api-balance',
      path: '/api/balance',
      type: 'GET',
      handler: async (req: any, res: any) => {
        try {
          const service = req.runtime.getService(SeiSwapService.serviceType) as SeiSwapService;
          if (!service) {
            return res.status(500).json({ error: 'SEI swap service not available' });
          }

          const tokens = service.getAvailableTokens();
          const balances: Record<string, string> = {};
          
          for (const [key, tokenInfo] of Object.entries(tokens)) {
            try {
              balances[tokenInfo.symbol] = await service.getTokenBalance(tokenInfo.address);
            } catch (error) {
              balances[tokenInfo.symbol] = '0';
            }
          }

          res.json(balances);
        } catch (error) {
          res.status(500).json({
            error: 'Failed to get balances',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  ],
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (params: MessagePayload) => {
        logger.debug('MESSAGE_RECEIVED event received');
        logger.debug({ message: params.message }, 'Message:');
      },
    ],
  },
  services: [SeiSwapService],
  actions: [swapSeiAction, getBalanceAction],
  providers: [],
};

export default seiSwapPlugin;
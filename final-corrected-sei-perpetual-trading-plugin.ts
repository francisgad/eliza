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

/**
 * Defines the configuration schema for the SEI perpetual trading plugin
 */
const configSchema = z.object({
  SEI_PRIVATE_KEY: z.string().min(1, 'SEI private key is required'),
  RPC_URL: z.string().url().default('https://evm-rpc.sei-apis.com'),
  CITREX_ENVIRONMENT: z.enum(['mainnet', 'testnet']).default('mainnet'),
  SUB_ACCOUNT_ID: z.number().default(0),
  DEBUG: z.boolean().default(false),
});

// Define our own types based on what the sei-agent-kit actually uses
type OrderType = 'LIMIT' | 'MARKET' | 'STOP_LIMIT' | 'STOP_MARKET';
type TimeInForce = 'GTC' | 'IOC' | 'FOK';
type ProductSymbol = `${string}perp`;

/**
 * Interface for Citrex SDK configuration (following sei-agent-kit pattern)
 */
interface CitrexConfig {
  debug: boolean;
  environment: 'mainnet' | 'testnet';
  rpc: string;
  subAccountId: number;
}

/**
 * Interface for order arguments (following sei-agent-kit pattern)
 */
interface OrderArgs {
  isBuy: boolean;
  orderType: OrderType;
  price?: number;
  productId: number;
  quantity: number;
  timeInForce: TimeInForce;
  clientId?: string;
}

/**
 * Interface for product information
 */
interface Product {
  active: boolean;
  baseAsset: string;
  baseAssetAddress: string;
  increment: bigint;
  id: number;
  initialLongWeight: bigint;
  initialShortWeight: bigint;
  isMakerRebate: boolean;
  makerFee: bigint;
  maintenanceLongWeight: bigint;
  maintenanceShortWeight: bigint;
  markPrice: number;
  maxQuantity: bigint;
  minQuantity: bigint;
  quoteAsset: string;
  quoteAssetAddress: string;
  symbol: string;
  takerFee: bigint;
  type: string;
}

/**
 * Interface for position data
 */
interface Position {
  productId: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  margin: number;
  liquidationPrice: number;
}

/**
 * Interface for order data (simplified)
 */
interface Order {
  id: string;
  productId: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  quantity: number;
  price: number;
  status: string;
  timeInForce: string;
  createdAt: string;
}

/**
 * SEI Perpetual Trading Service using Citrex protocol (following sei-agent-kit patterns)
 */
export class SeiPerpetualTradingService extends Service {
  static override serviceType = 'sei-perpetual-trading';

  override capabilityDescription =
    'Provides comprehensive SEI perpetual trading functionality using Citrex protocol including order management, position tracking, and market data.';

  // Make config public and properly typed as Metadata (string-indexed object)
  public override config: Record<string, any> = {};
  private citrexConfig: CitrexConfig;
  private privateKey: string;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    
    this.privateKey = process.env.SEI_PRIVATE_KEY || '';
    if (!this.privateKey) {
      throw new Error('SEI_PRIVATE_KEY environment variable is required');
    }

    // Store as public config for Service compatibility
    this.config = {
      debug: process.env.DEBUG === 'true' || false,
      environment: process.env.CITREX_ENVIRONMENT || 'mainnet',
      rpc: process.env.RPC_URL || 'https://evm-rpc.sei-apis.com',
      subAccountId: parseInt(process.env.SUB_ACCOUNT_ID || '0'),
    };

    // Create properly typed Citrex config (following sei-agent-kit pattern)
    this.citrexConfig = {
      debug: this.config.debug,
      environment: this.config.environment as 'mainnet' | 'testnet',
      rpc: this.config.rpc,
      subAccountId: this.config.subAccountId,
    };
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info('Starting SEI perpetual trading service');
    return new SeiPerpetualTradingService(runtime);
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('Stopping SEI perpetual trading service');
    const service = runtime.getService(SeiPerpetualTradingService.serviceType);
    if (!service) {
      throw new Error('SEI perpetual trading service not found');
    }
    if ('stop' in service && typeof service.stop === 'function') {
      await service.stop();
    }
  }

  override async stop(): Promise<void> {
    logger.info('SEI perpetual trading service stopped');
  }

  /**
   * Initialize Citrex SDK client (following sei-agent-kit pattern)
   */
  private async initCitrexClient(): Promise<any> {
    try {
      // Dynamic import like sei-agent-kit does, but handle it properly
      const CitrexSDK = (await import('citrex-sdk')).default;
      
      // Ensure private key has proper hex format (following sei-agent-kit pattern)
      const formattedKey = this.privateKey.startsWith('0x') ? this.privateKey : `0x${this.privateKey}`;
      return new CitrexSDK(formattedKey as `0x${string}`, this.citrexConfig);
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Citrex SDK');
      throw new Error('Failed to initialize Citrex SDK. Make sure citrex-sdk is installed.');
    }
  }

  /**
   * Get all available products (following sei-agent-kit pattern)
   */
  async getProducts(): Promise<Product[]> {
    try {
      const client = await this.initCitrexClient();
      const result = await client.getProducts();
      
      // Following sei-agent-kit pattern for formatting markPrice
      return result.products.map((product: any) => ({
        ...product,
        markPrice: Number(product.markPrice) / Math.pow(10, 18) // Format Wei to decimal
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get products');
      throw new Error(`Failed to get products: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get specific product by ID or symbol (following sei-agent-kit pattern)
   */
  async getProduct(productIdOrSymbol: number | string): Promise<Product> {
    try {
      const client = await this.initCitrexClient();
      const result = await client.getProduct(productIdOrSymbol);
      
      // Handle the result structure properly - check if it's an error response
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        throw new Error(result.error.message || 'Failed to get product');
      }

      // The result might be the product directly or have a product property
      const product = result.product || result;
      
      return {
        ...product,
        markPrice: (product.markPrice ? Number(product.markPrice) / Math.pow(10, 18) : 0)
      } as Product;
    } catch (error) {
      logger.error({ error }, 'Failed to get product');
      throw new Error(`Failed to get product: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get account balances (following sei-agent-kit pattern)
   */
  async getBalances(): Promise<any> {
    try {
      const client = await this.initCitrexClient();
      const result = await client.listBalances();
      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to get balances');
      throw new Error(`Failed to get balances: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get open positions (following sei-agent-kit pattern)
   */
  async getPositions(productSymbol?: string): Promise<Position[]> {
    try {
      const client = await this.initCitrexClient();
      // Cast to ProductSymbol if provided, otherwise undefined (following sei-agent-kit pattern)
      const symbolParam = productSymbol ? (productSymbol as ProductSymbol) : undefined;
      const result = await client.listPositions(symbolParam);
      
      // Map result to our interface
      return (result.positions || []).map((pos: any) => ({
        productId: pos.productId || 0,
        symbol: pos.symbol || '',
        side: pos.side || 'LONG',
        size: pos.size || 0,
        entryPrice: pos.entryPrice || 0,
        markPrice: pos.markPrice || 0,
        unrealizedPnl: pos.unrealizedPnl || 0,
        margin: pos.margin || 0,
        liquidationPrice: pos.liquidationPrice || 0,
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get positions');
      throw new Error(`Failed to get positions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get open orders (following sei-agent-kit pattern with correct return type)
   */
  async getOpenOrders(productSymbol?: string): Promise<Order[]> {
    try {
      const client = await this.initCitrexClient();
      // Cast to ProductSymbol if provided, otherwise undefined (following sei-agent-kit pattern)
      const symbolParam = productSymbol ? (productSymbol as ProductSymbol) : undefined;
      const result = await client.listOpenOrders(symbolParam);
      
      // Map result to our simplified interface
      return (result.orders || []).map((order: any) => ({
        id: order.id || order.orderId || '',
        productId: order.productId || 0,
        symbol: order.symbol || '',
        side: order.isBuy ? 'BUY' : 'SELL',
        orderType: order.orderType || order.type || '',
        quantity: order.quantity || 0,
        price: order.price || 0,
        status: order.status || '',
        timeInForce: order.timeInForce || '',
        createdAt: order.createdAt || order.timestamp || '',
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get open orders');
      throw new Error(`Failed to get open orders: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Place a single order (following sei-agent-kit pattern exactly)
   */
  async placeOrder(orderArgs: OrderArgs): Promise<any> {
    try {
      logger.info(`Placing order: ${orderArgs.isBuy ? 'BUY' : 'SELL'} ${orderArgs.quantity} at ${orderArgs.price || 'MARKET'}`);
      
      const client = await this.initCitrexClient();
      
      // Create order args with proper handling of optional price (following sei-agent-kit pattern)
      const citrexOrderArgs: any = {
        isBuy: orderArgs.isBuy,
        orderType: orderArgs.orderType,
        productId: orderArgs.productId,
        quantity: orderArgs.quantity,
        timeInForce: orderArgs.timeInForce,
      };

      // Only add price if it's defined (following sei-agent-kit pattern)
      if (orderArgs.price !== undefined) {
        citrexOrderArgs.price = orderArgs.price;
      }

      // Only add clientId if it's defined
      if (orderArgs.clientId !== undefined) {
        citrexOrderArgs.clientId = orderArgs.clientId;
      }
      
      const result = await client.placeOrder(citrexOrderArgs);
      
      // Handle different result structures (following sei-agent-kit pattern)
      const orderId = result?.order?.id || result?.orderId || 'N/A';
      logger.info(`Order placed successfully: ${orderId}`);
      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to place order');
      throw new Error(`Failed to place order: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Place multiple orders (following sei-agent-kit pattern)
   */
  async placeOrders(orders: OrderArgs[]): Promise<any> {
    try {
      logger.info(`Placing ${orders.length} orders`);
      
      const client = await this.initCitrexClient();
      
      // Convert our OrderArgs array with proper handling of optional fields
      const citrexOrders: any[] = orders.map(order => {
        const citrexOrder: any = {
          isBuy: order.isBuy,
          orderType: order.orderType,
          productId: order.productId,
          quantity: order.quantity,
          timeInForce: order.timeInForce,
        };

        // Only add price if it's defined
        if (order.price !== undefined) {
          citrexOrder.price = order.price;
        }

        // Only add clientId if it's defined
        if (order.clientId !== undefined) {
          citrexOrder.clientId = order.clientId;
        }

        return citrexOrder;
      });
      
      const result = await client.placeOrders(citrexOrders);
      
      logger.info(`${orders.length} orders placed successfully`);
      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to place orders');
      throw new Error(`Failed to place orders: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Cancel an order (following sei-agent-kit pattern exactly)
   */
  async cancelOrder(orderId: string, productId: number): Promise<any> {
    try {
      logger.info(`Cancelling order: ${orderId}`);
      
      const client = await this.initCitrexClient();
      
      // Following sei-agent-kit pattern - orderId should be hex string
      const hexOrderId = orderId.startsWith('0x') ? orderId : `0x${orderId}`;
      const result = await client.cancelOrder(hexOrderId as `0x${string}`, productId);
      
      logger.info(`Order cancelled successfully: ${orderId}`);
      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to cancel order');
      throw new Error(`Failed to cancel order: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Cancel all orders for a product (following sei-agent-kit pattern - uses productId, not symbol)
   */
  async cancelAllOrders(productId: number): Promise<any> {
    try {
      logger.info(`Cancelling all orders for product ${productId}`);
      
      const client = await this.initCitrexClient();
      const result = await client.cancelOpenOrdersForProduct(productId);
      
      logger.info(`All orders cancelled for product ${productId}`);
      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to cancel all orders');
      throw new Error(`Failed to cancel all orders: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get order book (following sei-agent-kit pattern)
   */
  async getOrderBook(productSymbol: string): Promise<any> {
    try {
      const client = await this.initCitrexClient();
      const result = await client.getOrderBook(productSymbol as ProductSymbol);
      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to get order book');
      throw new Error(`Failed to get order book: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get account health (following sei-agent-kit pattern)
   */
  async getAccountHealth(): Promise<any> {
    try {
      const client = await this.initCitrexClient();
      const result = await client.getAccountHealth();
      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to get account health');
      throw new Error(`Failed to get account health: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Deposit funds (following sei-agent-kit pattern)
   */
  async deposit(amount: number): Promise<any> {
    try {
      logger.info(`Depositing ${amount} USDC`);
      
      const client = await this.initCitrexClient();
      const result = await client.deposit(amount);
      
      logger.info(`Deposit successful: ${amount} USDC`);
      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to deposit');
      throw new Error(`Failed to deposit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Withdraw funds (following sei-agent-kit pattern)
   */
  async withdraw(amount: number): Promise<any> {
    try {
      logger.info(`Withdrawing ${amount} USDC`);
      
      const client = await this.initCitrexClient();
      const result = await client.withdraw(amount);
      
      logger.info(`Withdrawal successful: ${amount} USDC`);
      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to withdraw');
      throw new Error(`Failed to withdraw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Parse trading command from natural language
   */
  parseTradeCommand(text: string): { 
    action: string; 
    symbol?: string; 
    side?: string; 
    quantity?: number; 
    price?: number; 
    orderType?: OrderType 
  } {
    const lowerText = text.toLowerCase();
    
    // Extract action
    let action = '';
    if (lowerText.includes('buy') || lowerText.includes('long')) action = 'buy';
    else if (lowerText.includes('sell') || lowerText.includes('short')) action = 'sell';
    else if (lowerText.includes('cancel')) action = 'cancel';
    else if (lowerText.includes('close')) action = 'close';
    
    // Extract symbol
    const symbolMatch = lowerText.match(/(btc|eth|sol|atom|sei|usdc|usdt)(?:perp|perpetual)?/i);
    const symbol = symbolMatch ? symbolMatch[1].toUpperCase() + 'PERP' : undefined;
    
    // Extract quantity
    const quantityMatch = lowerText.match(/(\d+(?:\.\d+)?)\s*(?:units?|contracts?|amount)?/);
    const quantity = quantityMatch ? parseFloat(quantityMatch[1]) : undefined;
    
    // Extract price
    const priceMatch = lowerText.match(/(?:at|price|@)\s*(\d+(?:\.\d+)?)/);
    const price = priceMatch ? parseFloat(priceMatch[1]) : undefined;
    
    // Determine order type
    let orderType: OrderType = 'MARKET';
    if (price || lowerText.includes('limit')) orderType = 'LIMIT';
    if (lowerText.includes('market')) orderType = 'MARKET';
    
    return { action, symbol, side: action, quantity, price, orderType };
  }
}

// Trading Actions
const placeOrderAction: Action = {
  name: 'PLACE_PERPETUAL_ORDER',
  similes: ['BUY_PERP', 'SELL_PERP', 'TRADE_PERP', 'LONG_POSITION', 'SHORT_POSITION'],
  description: 'Places perpetual trading orders on SEI using Citrex protocol',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return (text.includes('buy') || text.includes('sell') || text.includes('long') || text.includes('short')) &&
           (text.includes('perp') || text.includes('perpetual') || text.includes('btc') || text.includes('eth') || text.includes('sol'));
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
          text: 'I need a message with text to process your trading request.',
        };
      }

      const service = runtime.getService(SeiPerpetualTradingService.serviceType);
      if (!service || !(service instanceof SeiPerpetualTradingService)) {
        throw new Error('SEI perpetual trading service not available');
      }

      const command = service.parseTradeCommand(message.content.text);
      
      if (!command.action || !command.symbol || !command.quantity) {
        return {
          success: false,
          error: new Error('Invalid trade command'),
          text: 'Please specify the action (buy/sell), symbol (BTC/ETH/SOL), and quantity. Example: "Buy 0.1 BTC at 45000"',
        };
      }

      // Get product info to get product ID
      const products = await service.getProducts();
      const product = products.find(p => p.symbol.toLowerCase() === command.symbol?.toLowerCase());
      
      if (!product) {
        return {
          success: false,
          error: new Error('Product not found'),
          text: `Product ${command.symbol} not found. Available products: ${products.map(p => p.symbol).join(', ')}`,
        };
      }

      // Prepare order arguments
      const orderArgs: OrderArgs = {
        isBuy: command.action === 'buy',
        orderType: command.orderType || 'MARKET',
        productId: product.id,
        quantity: command.quantity,
        timeInForce: 'GTC',
      };

      // Only set price if it's defined and order type is LIMIT
      if (command.price !== undefined && command.orderType === 'LIMIT') {
        orderArgs.price = command.price;
      }

      // Place the order
      const result = await service.placeOrder(orderArgs);

      const orderId = result?.order?.id || result?.orderId || 'N/A';
      const response = `✅ **Order Placed Successfully**\n\n` +
        `📊 **Details:**\n` +
        `• Symbol: ${product.symbol}\n` +
        `• Side: ${command.action.toUpperCase()}\n` +
        `• Quantity: ${command.quantity}\n` +
        `• Type: ${orderArgs.orderType}\n` +
        `${orderArgs.price ? `• Price: $${orderArgs.price}\n` : ''}` +
        `• Order ID: ${orderId}\n\n` +
        `🔗 **Transaction Hash:** ${result.txHash || 'N/A'}`;

      if (callback) {
        await callback({
          text: response,
          actions: ['PLACE_PERPETUAL_ORDER'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['PLACE_PERPETUAL_ORDER'],
          source: message.content.source,
          orderResult: result,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to place order';
      logger.error({ error }, 'Place order action failed');
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: `❌ Sorry, I couldn't place your order. ${errorMessage}`,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Buy 0.1 BTC at 45000',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✅ **Order Placed Successfully**\n\n📊 **Details:**\n• Symbol: BTCPERP\n• Side: BUY\n• Quantity: 0.1\n• Type: LIMIT\n• Price: $45000\n• Order ID: 12345',
          actions: ['PLACE_PERPETUAL_ORDER'],
        },
      },
    ],
  ],
};

const getPositionsAction: Action = {
  name: 'GET_PERPETUAL_POSITIONS',
  similes: ['CHECK_POSITIONS', 'MY_POSITIONS', 'OPEN_POSITIONS', 'PORTFOLIO'],
  description: 'Gets current perpetual trading positions',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return text.includes('position') || text.includes('portfolio') || text.includes('holdings');
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
      const service = runtime.getService(SeiPerpetualTradingService.serviceType);
      if (!service || !(service instanceof SeiPerpetualTradingService)) {
        throw new Error('SEI perpetual trading service not available');
      }

      const positions = await service.getPositions();
      
      if (!positions || positions.length === 0) {
        const response = '📊 **No Open Positions**\n\nYou currently have no open perpetual positions.';
        
        if (callback) {
          await callback({
            text: response,
            actions: ['GET_PERPETUAL_POSITIONS'],
            source: message.content.source,
          });
        }

        return {
          text: response,
          success: true,
          data: {
            actions: ['GET_PERPETUAL_POSITIONS'],
            source: message.content.source,
            positions: [],
          },
        };
      }

      const response = `📊 **Open Positions (${positions.length})**\n\n` +
        positions.map((pos, index) => 
          `**${index + 1}. ${pos.symbol}**\n` +
          `• Side: ${pos.side}\n` +
          `• Size: ${pos.size}\n` +
          `• Entry Price: $${pos.entryPrice}\n` +
          `• Mark Price: $${pos.markPrice}\n` +
          `• Unrealized PnL: ${pos.unrealizedPnl >= 0 ? '+' : ''}$${pos.unrealizedPnl.toFixed(2)}\n` +
          `• Liquidation Price: $${pos.liquidationPrice}\n`
        ).join('\n');

      if (callback) {
        await callback({
          text: response,
          actions: ['GET_PERPETUAL_POSITIONS'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['GET_PERPETUAL_POSITIONS'],
          source: message.content.source,
          positions,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to get positions';
      logger.error({ error }, 'Get positions action failed');
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: `❌ Sorry, I couldn't get your positions. ${errorMessage}`,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Show my positions',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '📊 **Open Positions (2)**\n\n**1. BTCPERP**\n• Side: LONG\n• Size: 0.1\n• Entry Price: $45000\n• Mark Price: $46000\n• Unrealized PnL: +$100.00',
          actions: ['GET_PERPETUAL_POSITIONS'],
        },
      },
    ],
  ],
};

const getBalanceAction: Action = {
  name: 'GET_TRADING_BALANCE',
  similes: ['CHECK_BALANCE', 'MARGIN_BALANCE', 'ACCOUNT_BALANCE'],
  description: 'Gets trading account balance and margin information',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return text.includes('balance') || text.includes('margin') || text.includes('account');
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
      const service = runtime.getService(SeiPerpetualTradingService.serviceType);
      if (!service || !(service instanceof SeiPerpetualTradingService)) {
        throw new Error('SEI perpetual trading service not available');
      }

      const [balances, accountHealth] = await Promise.all([
        service.getBalances(),
        service.getAccountHealth()
      ]);

      const response = `💰 **Trading Account Summary**\n\n` +
        `**💵 Balances:**\n` +
        `• Available: $${balances.available || '0'}\n` +
        `• Total: $${balances.total || '0'}\n` +
        `• Used Margin: $${balances.usedMargin || '0'}\n\n` +
        `**🏥 Account Health:**\n` +
        `• Health Ratio: ${accountHealth.healthRatio || 'N/A'}\n` +
        `• Maintenance Margin: $${accountHealth.maintenanceMargin || '0'}\n` +
        `• Free Collateral: $${accountHealth.freeCollateral || '0'}`;

      if (callback) {
        await callback({
          text: response,
          actions: ['GET_TRADING_BALANCE'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['GET_TRADING_BALANCE'],
          source: message.content.source,
          balances,
          accountHealth,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to get balance';
      logger.error({ error }, 'Get balance action failed');
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: `❌ Sorry, I couldn't get your balance. ${errorMessage}`,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Check my trading balance',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '💰 **Trading Account Summary**\n\n**💵 Balances:**\n• Available: $1000\n• Total: $1500\n• Used Margin: $500',
          actions: ['GET_TRADING_BALANCE'],
        },
      },
    ],
  ],
};

export const seiPerpetualTradingPlugin: Plugin = {
  name: 'plugin-sei-perpetual-trading',
  description: 'Comprehensive SEI perpetual trading functionality using Citrex protocol',
  config: {
    SEI_PRIVATE_KEY: process.env.SEI_PRIVATE_KEY,
    RPC_URL: process.env.RPC_URL,
    CITREX_ENVIRONMENT: process.env.CITREX_ENVIRONMENT,
    SUB_ACCOUNT_ID: process.env.SUB_ACCOUNT_ID,
    DEBUG: process.env.DEBUG,
  },
  async init(config: Record<string, string>) {
    logger.info('Initializing plugin-sei-perpetual-trading');
    try {
      const validatedConfig = await configSchema.parseAsync({
        ...config,
        SUB_ACCOUNT_ID: config.SUB_ACCOUNT_ID ? parseInt(config.SUB_ACCOUNT_ID) : 0,
        DEBUG: config.DEBUG === 'true',
      });

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value !== undefined) process.env[key] = String(value);
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
      return 'I can help you with SEI perpetual trading using Citrex protocol.';
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
      return 'I specialize in SEI perpetual trading using the Citrex protocol. I can help you place orders, manage positions, check balances, and monitor your trading account. You can ask me to buy/sell perpetual contracts, check your positions, or get market data.';
    },
  },
  routes: [
    {
      name: 'api-trading-products',
      path: '/api/trading/products',
      type: 'GET',
      handler: async (req: any, res: any) => {
        try {
          const service = req.runtime.getService(SeiPerpetualTradingService.serviceType);
          if (!service || !(service instanceof SeiPerpetualTradingService)) {
            return res.status(500).json({ error: 'SEI perpetual trading service not available' });
          }

          const products = await service.getProducts();
          res.json(products);
        } catch (error) {
          res.status(500).json({
            error: 'Failed to get products',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'api-trading-positions',
      path: '/api/trading/positions',
      type: 'GET',
      handler: async (req: any, res: any) => {
        try {
          const service = req.runtime.getService(SeiPerpetualTradingService.serviceType);
          if (!service || !(service instanceof SeiPerpetualTradingService)) {
            return res.status(500).json({ error: 'SEI perpetual trading service not available' });
          }

          const positions = await service.getPositions();
          res.json(positions);
        } catch (error) {
          res.status(500).json({
            error: 'Failed to get positions',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'api-trading-place-order',
      path: '/api/trading/order',
      type: 'POST',
      handler: async (req: any, res: any) => {
        try {
          const { isBuy, orderType, price, productId, quantity, timeInForce } = req.body;
          
          if (typeof isBuy !== 'boolean' || !orderType || !productId || !quantity || !timeInForce) {
            return res.status(400).json({ 
              error: 'isBuy, orderType, productId, quantity, and timeInForce are required' 
            });
          }

          const service = req.runtime.getService(SeiPerpetualTradingService.serviceType);
          if (!service || !(service instanceof SeiPerpetualTradingService)) {
            return res.status(500).json({ error: 'SEI perpetual trading service not available' });
          }

          const orderArgs: OrderArgs = {
            isBuy,
            orderType: orderType as OrderType,
            productId,
            quantity,
            timeInForce: timeInForce as TimeInForce,
          };

          // Only add price if it's provided and not undefined
          if (price !== undefined) {
            orderArgs.price = price;
          }

          const result = await service.placeOrder(orderArgs);
          res.json(result);
        } catch (error) {
          res.status(500).json({
            error: 'Failed to place order',
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
  services: [SeiPerpetualTradingService],
  actions: [placeOrderAction, getPositionsAction, getBalanceAction],
  providers: [],
};

export default seiPerpetualTradingPlugin;
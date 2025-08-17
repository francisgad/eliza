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
import axios from 'axios';
import { ethers } from 'ethers';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';
import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet, OfflineDirectSigner } from '@cosmjs/proto-signing';
import { MsgVote } from 'cosmjs-types/cosmos/gov/v1beta1/tx';
import { MsgDelegate, MsgUndelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx';
import { Coin } from 'cosmjs-types/cosmos/base/v1beta1/coin';
import { Any } from 'cosmjs-types/google/protobuf/any';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import * as bech32 from 'bech32';

/**
 * Configuration schema for the SEI governance agent
 */
const configSchema = z.object({
  SEI_RPC_URL: z
    .string()
    .url()
    .default('https://sei-rpc.polkachu.com')
    .transform((val) => val.trim()),
  SEI_REST_URL: z
    .string()
    .url()
    .default('https://sei-api.polkachu.com')
    .transform((val) => val.trim()),
  SEI_MNEMONIC: z.string().optional(),
  SEI_PRIVATE_KEY: z.string().optional(),
  SEI_CHAIN_ID: z.string().default('pacific-1'),
  SEI_ADDRESS_PREFIX: z.string().default('sei'),
});

/**
 * Enhanced governance proposal interface
 */
interface GovernanceProposal {
  proposal_id: string;
  content?: {
    '@type': string;
    title: string;
    description: string;
  };
  status: string;
  final_tally_result: {
    yes: string;
    abstain: string;
    no: string;
    no_with_veto: string;
  };
  submit_time: string;
  deposit_end_time: string;
  total_deposit: Array<{
    denom: string;
    amount: string;
  }>;
  voting_start_time: string;
  voting_end_time: string;
}

/**
 * Enhanced validator interface
 */
interface Validator {
  operator_address: string;
  consensus_pubkey: {
    '@type': string;
    key: string;
  };
  jailed: boolean;
  status: string;
  tokens: string;
  delegator_shares: string;
  description: {
    moniker: string;
    identity: string;
    website: string;
    security_contact: string;
    details: string;
  };
  unbonding_height: string;
  unbonding_time: string;
  commission: {
    commission_rates: {
      rate: string;
      max_rate: string;
      max_change_rate: string;
    };
    update_time: string;
  };
  min_self_delegation: string;
}

/**
 * Vote option enum
 */
enum VoteOption {
  VOTE_OPTION_UNSPECIFIED = 0,
  VOTE_OPTION_YES = 1,
  VOTE_OPTION_ABSTAIN = 2,
  VOTE_OPTION_NO = 3,
  VOTE_OPTION_NO_WITH_VETO = 4,
}

/**
 * Transaction result interface
 */
interface TransactionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  gasUsed?: string;
  gasWanted?: string;
}

/**
 * Enhanced SEI Governance Agent Service
 */
export class SeiGovernanceService extends Service {
  static override serviceType = 'sei_governance';

  override capabilityDescription =
    'Full-featured SEI blockchain governance agent with real voting, delegation, and proposal management capabilities.';

  private rpcUrl: string;
  private restUrl: string;
  private chainId: string;
  private addressPrefix: string;
  private mnemonic?: string;
  private privateKey?: string;
  private wallet?: DirectSecp256k1HdWallet | DirectSecp256k1Wallet;
  private signingClient?: SigningStargateClient;
  private walletAddress?: string;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.rpcUrl = process.env.SEI_RPC_URL || 'https://sei-rpc.polkachu.com';
    this.restUrl = process.env.SEI_REST_URL || 'https://sei-api.polkachu.com';
    this.chainId = process.env.SEI_CHAIN_ID || 'pacific-1';
    this.addressPrefix = process.env.SEI_ADDRESS_PREFIX || 'sei';
    this.mnemonic = process.env.SEI_MNEMONIC;
    this.privateKey = process.env.SEI_PRIVATE_KEY;
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info('🚀 Starting SEI Governance Agent');
    const service = new SeiGovernanceService(runtime);
    await service.initialize();
    return service;
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('🛑 Stopping SEI Governance Agent');
    const service = runtime.getService(SeiGovernanceService.serviceType);
    if (service && 'stop' in service && typeof service.stop === 'function') {
      await service.stop();
    }
  }

  override async stop(): Promise<void> {
    if (this.signingClient) {
      this.signingClient.disconnect();
    }
    logger.info('✅ SEI Governance Agent stopped');
  }

  /**
   * Initialize the wallet and signing client
   */
  private async initialize(): Promise<void> {
    try {
      if (this.mnemonic) {
        // Create wallet from mnemonic
        this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(
          this.mnemonic,
          {
            prefix: this.addressPrefix,
          }
        );
        logger.info('✅ SEI wallet initialized from mnemonic');
      } else if (this.privateKey) {
        // Create wallet from private key
        const privateKeyBytes = ethers.getBytes(this.privateKey);
        this.wallet = await DirectSecp256k1Wallet.fromKey(
          privateKeyBytes,
          this.addressPrefix
        );
        logger.info('✅ SEI wallet initialized from private key');
      } else {
        logger.warn('⚠️ No wallet credentials provided. Voting and delegation features disabled.');
        return;
      }

      // Get wallet address
      if (!this.wallet) {
        throw new Error('Wallet initialization failed');
      }

      const [firstAccount] = await this.wallet.getAccounts();
      this.walletAddress = firstAccount.address;
      logger.info(`👛 Wallet address: ${this.walletAddress}`);

      // Initialize signing client
      const gasPrice = GasPrice.fromString('0.1usei');
      this.signingClient = await SigningStargateClient.connectWithSigner(
        this.rpcUrl,
        this.wallet,
        {
          gasPrice,
        }
      );
      logger.info('✅ SigningStargateClient connected');

    } catch (error) {
      logger.error({ error }, '❌ Failed to initialize SEI wallet');
      throw error;
    }
  }

  /**
   * Convert EVM address to SEI bech32 address
   */
  evmToSeiAddress(evmAddress: string): string {
    try {
      // Remove 0x prefix
      const hexAddress = evmAddress.startsWith('0x') ? evmAddress.slice(2) : evmAddress;
      
      // Convert hex to bytes
      const addressBytes = Buffer.from(hexAddress, 'hex');
      
      // Convert to bech32 with sei prefix
      return toBech32(this.addressPrefix, addressBytes);
    } catch (error) {
      logger.error({ error, evmAddress }, 'Failed to convert EVM address to SEI address');
      throw new Error(`Invalid EVM address: ${evmAddress}`);
    }
  }

  /**
   * Get governance proposals with proper error handling and formatting
   */
  async getProposals(status?: string, limit: number = 50): Promise<GovernanceProposal[]> {
    try {
      let url = `${this.restUrl}/cosmos/gov/v1beta1/proposals`;
      const params: any = {};
      
      if (status && status !== 'all') {
        params.proposal_status = status;
      }
      
      params['pagination.limit'] = limit.toString();

      const response = await axios.get(url, {
        params,
        headers: { 
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 15000,
      });

      if (!response.data || !response.data.proposals) {
        logger.warn('No proposals found in response');
        return [];
      }

      return response.data.proposals;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 400) {
        try {
          logger.info('Trying alternative endpoint without status filter...');
          const response = await axios.get(`${this.restUrl}/cosmos/gov/v1beta1/proposals`, {
            params: { 'pagination.limit': limit.toString() },
            headers: { 'Accept': 'application/json' },
            timeout: 15000,
          });
          
          let proposals = response.data?.proposals || [];
          
          if (status && status !== 'all') {
            proposals = proposals.filter((p: any) => p.status === status);
          }
          
          return proposals;
        } catch (secondError) {
          logger.error({ error: secondError }, 'Secondary proposal fetch also failed');
          throw new Error(`Failed to get proposals: ${secondError instanceof Error ? secondError.message : String(secondError)}`);
        }
      }
      
      logger.error({ error }, 'Failed to fetch governance proposals');
      throw new Error(`Failed to get proposals: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get specific proposal by ID
   */
  async getProposal(proposalId: string): Promise<GovernanceProposal> {
    try {
      const response = await axios.get(`${this.restUrl}/cosmos/gov/v1beta1/proposals/${proposalId}`, {
        headers: { accept: 'application/json' },
        timeout: 10000,
      });

      return response.data?.proposal;
    } catch (error) {
      logger.error({ error, proposalId }, 'Failed to fetch proposal');
      throw new Error(`Failed to get proposal ${proposalId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get validators with enhanced formatting
   */
  async getValidators(status: string = 'BOND_STATUS_BONDED', limit: number = 100): Promise<Validator[]> {
    try {
      const params: any = {
        'pagination.limit': limit.toString()
      };
      
      if (status !== 'all') {
        params.status = status;
      }

      const response = await axios.get(`${this.restUrl}/cosmos/staking/v1beta1/validators`, {
        params,
        headers: { 
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 15000,
      });

      return response.data?.validators || [];
    } catch (error) {
      logger.error({ error }, 'Failed to fetch validators');
      throw new Error(`Failed to get validators: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get vote for a specific proposal and voter
   */
  async getVote(proposalId: string, voterAddress: string): Promise<any> {
    try {
      const response = await axios.get(`${this.restUrl}/cosmos/gov/v1beta1/proposals/${proposalId}/votes/${voterAddress}`, {
        headers: { accept: 'application/json' },
      });

      return response.data?.vote;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get proposal votes summary
   */
  async getProposalVotes(proposalId: string): Promise<any[]> {
    try {
      const response = await axios.get(`${this.restUrl}/cosmos/gov/v1beta1/proposals/${proposalId}/votes`, {
        headers: { accept: 'application/json' },
        params: { 'pagination.limit': 1000 }
      });

      return response.data?.votes || [];
    } catch (error) {
      logger.error({ error, proposalId }, 'Failed to fetch proposal votes');
      return [];
    }
  }

  /**
   * Create and broadcast vote transaction
   */
  async voteOnProposal(proposalId: string, voteOption: VoteOption): Promise<TransactionResult> {
    try {
      if (!this.signingClient || !this.walletAddress) {
        throw new Error('Wallet not initialized. Please configure SEI_MNEMONIC or SEI_PRIVATE_KEY');
      }

      logger.info(`Creating vote transaction for proposal ${proposalId} with option ${voteOption}`);

      // Create the vote message
      const voteMsg = {
        typeUrl: '/cosmos.gov.v1beta1.MsgVote',
        value: MsgVote.fromPartial({
          proposalId: BigInt(proposalId),
          voter: this.walletAddress,
          option: voteOption,
        }),
      };

      // Estimate gas
      const gasEstimation = await this.signingClient.simulate(
        this.walletAddress,
        [voteMsg],
        'Vote on governance proposal'
      );

      const gasLimit = Math.ceil(gasEstimation * 1.5); // Add 50% buffer

      // Broadcast transaction
      const result = await this.signingClient.signAndBroadcast(
        this.walletAddress,
        [voteMsg],
        {
          amount: [{ denom: 'usei', amount: '1000' }],
          gas: gasLimit.toString(),
        },
        'Vote on governance proposal'
      );

      if (result.code !== 0) {
        throw new Error(`Transaction failed: ${result.rawLog}`);
      }

      logger.info(`Vote transaction successful: ${result.transactionHash}`);
      
      return {
        success: true,
        txHash: result.transactionHash,
        gasUsed: result.gasUsed?.toString(),
        gasWanted: result.gasWanted?.toString(),
      };

    } catch (error) {
      logger.error({ error }, 'Failed to vote on proposal');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Delegate tokens to a validator
   */
  async delegateTokens(validatorAddress: string, amount: string): Promise<TransactionResult> {
    try {
      if (!this.signingClient || !this.walletAddress) {
        throw new Error('Wallet not initialized. Please configure SEI_MNEMONIC or SEI_PRIVATE_KEY');
      }

      logger.info(`Delegating ${amount} usei to validator ${validatorAddress}`);

      // Create the delegation message
      const delegateMsg = {
        typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
        value: MsgDelegate.fromPartial({
          delegatorAddress: this.walletAddress,
          validatorAddress: validatorAddress,
          amount: {
            denom: 'usei',
            amount: amount,
          },
        }),
      };

      // Estimate gas
      const gasEstimation = await this.signingClient.simulate(
        this.walletAddress,
        [delegateMsg],
        'Delegate tokens'
      );

      const gasLimit = Math.ceil(gasEstimation * 1.5);

      // Broadcast transaction
      const result = await this.signingClient.signAndBroadcast(
        this.walletAddress,
        [delegateMsg],
        {
          amount: [{ denom: 'usei', amount: '2000' }],
          gas: gasLimit.toString(),
        },
        'Delegate tokens'
      );

      if (result.code !== 0) {
        throw new Error(`Transaction failed: ${result.rawLog}`);
      }

      logger.info(`Delegation transaction successful: ${result.transactionHash}`);
      
      return {
        success: true,
        txHash: result.transactionHash,
        gasUsed: result.gasUsed?.toString(),
        gasWanted: result.gasWanted?.toString(),
      };

    } catch (error) {
      logger.error({ error }, 'Failed to delegate tokens');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Undelegate tokens from a validator
   */
  async undelegateTokens(validatorAddress: string, amount: string): Promise<TransactionResult> {
    try {
      if (!this.signingClient || !this.walletAddress) {
        throw new Error('Wallet not initialized. Please configure SEI_MNEMONIC or SEI_PRIVATE_KEY');
      }

      logger.info(`Undelegating ${amount} usei from validator ${validatorAddress}`);

      // Create the undelegation message
      const undelegateMsg = {
        typeUrl: '/cosmos.staking.v1beta1.MsgUndelegate',
        value: MsgUndelegate.fromPartial({
          delegatorAddress: this.walletAddress,
          validatorAddress: validatorAddress,
          amount: {
            denom: 'usei',
            amount: amount,
          },
        }),
      };

      // Estimate gas
      const gasEstimation = await this.signingClient.simulate(
        this.walletAddress,
        [undelegateMsg],
        'Undelegate tokens'
      );

      const gasLimit = Math.ceil(gasEstimation * 1.5);

      // Broadcast transaction
      const result = await this.signingClient.signAndBroadcast(
        this.walletAddress,
        [undelegateMsg],
        {
          amount: [{ denom: 'usei', amount: '2000' }],
          gas: gasLimit.toString(),
        },
        'Undelegate tokens'
      );

      if (result.code !== 0) {
        throw new Error(`Transaction failed: ${result.rawLog}`);
      }

      logger.info(`Undelegation transaction successful: ${result.transactionHash}`);
      
      return {
        success: true,
        txHash: result.transactionHash,
        gasUsed: result.gasUsed?.toString(),
        gasWanted: result.gasWanted?.toString(),
      };

    } catch (error) {
      logger.error({ error }, 'Failed to undelegate tokens');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get wallet balance
   */
  async getWalletBalance(): Promise<{ denom: string; amount: string }[]> {
    try {
      if (!this.signingClient || !this.walletAddress) {
        throw new Error('Wallet not initialized');
      }

      const balance = await this.signingClient.getAllBalances(this.walletAddress);
      return balance.map(coin => ({ denom: coin.denom, amount: coin.amount }));
    } catch (error) {
      logger.error({ error }, 'Failed to get wallet balance');
      throw error;
    }
  }

  /**
   * Format proposal status
   */
  formatProposalStatus(status: string): string {
    const statusMap: Record<string, string> = {
      'PROPOSAL_STATUS_DEPOSIT_PERIOD': '💰 Deposit Period',
      'PROPOSAL_STATUS_VOTING_PERIOD': '🗳️  Voting Active',
      'PROPOSAL_STATUS_PASSED': '✅ Passed',
      'PROPOSAL_STATUS_REJECTED': '❌ Rejected',
      'PROPOSAL_STATUS_FAILED': '💥 Failed',
      'PROPOSAL_STATUS_UNSPECIFIED': '❓ Unspecified',
    };
    return statusMap[status] || status;
  }

  /**
   * Format SEI amount
   */
  formatSeiAmount(amount: string): string {
    const seiAmount = parseInt(amount) / 1000000;
    return seiAmount.toLocaleString('en-US', { 
      minimumFractionDigits: 2, 
      maximumFractionDigits: 2 
    });
  }

  /**
   * Calculate voting power percentage
   */
  calculateVotingPower(tokens: string, totalSupply: number): string {
    const validatorTokens = parseInt(tokens) / 1000000;
    const percentage = (validatorTokens / totalSupply) * 100;
    return percentage.toFixed(4);
  }

  /**
   * Get wallet address for voting
   */
  getWalletAddress(): string | null {
    return this.walletAddress || null;
  }

  /**
   * Check if wallet is configured for voting
   */
  isWalletConfigured(): boolean {
    return !!(this.signingClient && this.walletAddress);
  }
}

/**
 * Enhanced Get Proposals Action
 */
const getProposalsAction: Action = {
  name: 'GET_SEI_PROPOSALS',
  similes: ['SEI_PROPOSALS', 'GOVERNANCE_PROPOSALS', 'PROPOSALS', 'SHOW_PROPOSALS'],
  description: 'Get SEI governance proposals with beautiful formatting',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return text.includes('proposal') || 
           text.includes('governance') || 
           text.includes('vote') ||
           text.includes('sei gov');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService(SeiGovernanceService.serviceType) as SeiGovernanceService;
      if (!service) {
        throw new Error('SEI governance service not available');
      }

      // Parse message for specific status or limit
      const text = message.content.text?.toLowerCase() || '';
      let status = undefined;
      let limit = 10;

      if (text.includes('active') || text.includes('voting')) {
        status = 'PROPOSAL_STATUS_VOTING_PERIOD';
      } else if (text.includes('passed')) {
        status = 'PROPOSAL_STATUS_PASSED';
      } else if (text.includes('rejected')) {
        status = 'PROPOSAL_STATUS_REJECTED';
      } else if (text.includes('all')) {
        status = 'all';
      }

      // Extract number from message
      const numberMatch = text.match(/\d+/);
      if (numberMatch) {
        limit = Math.min(parseInt(numberMatch[0]), 50);
      }

      const proposals = await service.getProposals(status, limit);
      
      if (proposals.length === 0) {
        const response = '🏛️ No governance proposals found matching your criteria.';
        
        if (callback) {
          await callback({
            text: response,
            actions: ['GET_SEI_PROPOSALS'],
            source: message.content.source,
          });
        }

        return { text: response, success: true };
      }

      let response = `🏛️ **SEI Governance Dashboard**\n\n`;
      response += `📊 Found ${proposals.length} proposals:\n\n`;

      proposals.forEach((proposal, index) => {
        const title = proposal.content?.title || `Proposal ${proposal.proposal_id}`;
        const status = service.formatProposalStatus(proposal.status);
        const votingEnd = new Date(proposal.voting_end_time);
        const isActive = proposal.status === 'PROPOSAL_STATUS_VOTING_PERIOD';
        
        response += `**${index + 1}. ${title}**\n`;
        response += `   📋 ID: #${proposal.proposal_id}\n`;
        response += `   ${status}\n`;
        
        if (isActive) {
          const timeLeft = Math.ceil((votingEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          response += `   ⏰ ${timeLeft > 0 ? `${timeLeft} days left` : 'Voting ended'}\n`;
        } else {
          response += `   📅 Ended: ${votingEnd.toLocaleDateString()}\n`;
        }

        // Show tally for completed proposals
        if (proposal.final_tally_result && proposal.status !== 'PROPOSAL_STATUS_VOTING_PERIOD') {
          const yes = service.formatSeiAmount(proposal.final_tally_result.yes || '0');
          const no = service.formatSeiAmount(proposal.final_tally_result.no || '0');
          response += `   📊 Yes: ${yes} SEI | No: ${no} SEI\n`;
        }
        
        response += '\n';
      });

      response += `\n💡 *Use "proposal details #ID" for more information*\n`;
      response += `🗳️  *Use "vote #ID yes/no/abstain/veto" to cast your vote*`;
      
      // Show wallet status
      if (!service.isWalletConfigured()) {
        response += `\n\n⚠️  *Configure SEI_MNEMONIC or SEI_PRIVATE_KEY to enable voting*`;
      } else {
        response += `\n👛 *Wallet configured: ${service.getWalletAddress()}*`;
      }

      if (callback) {
        await callback({
          text: response,
          actions: ['GET_SEI_PROPOSALS'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['GET_SEI_PROPOSALS'],
          source: message.content.source,
          proposals,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to get proposals';
      const response = `❌ Unable to fetch SEI proposals: ${errorMessage}`;
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: response,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Show me active SEI proposals',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '🏛️ **SEI Governance Dashboard**\n\n📊 Found 3 active proposals:\n\n**1. Increase Block Size Limit**\n   📋 ID: #42\n   🗳️ Voting Active\n   ⏰ 5 days left',
          actions: ['GET_SEI_PROPOSALS'],
        },
      },
    ],
  ]
  };

/**
 * Vote on Proposal Action
 */
const voteOnProposalAction: Action = {
  name: 'VOTE_ON_PROPOSAL',
  similes: ['VOTE', 'CAST_VOTE', 'GOVERNANCE_VOTE', 'PROPOSAL_VOTE'],
  description: 'Vote on a SEI governance proposal using your configured wallet',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return (
  text.includes('vote') &&
  (text.includes('yes') || text.includes('no') || text.includes('abstain') || text.includes('veto')) &&
  /\d+/.test(text) // check if there's a number (proposal ID)
);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService(SeiGovernanceService.serviceType) as SeiGovernanceService;
      if (!service) {
        throw new Error('SEI governance service not available');
      }

      if (!service.isWalletConfigured()) {
        const response = '❌ **Wallet Not Configured**\n\nTo vote on proposals, please set your `SEI_MNEMONIC` or `SEI_PRIVATE_KEY` in the environment variables.\n\n⚠️ Keep your credentials secure and never share them!';
        
        if (callback) {
          await callback({
            text: response,
            actions: ['VOTE_ON_PROPOSAL'],
            source: message.content.source,
          });
        }

        return { text: response, success: false };
      }

      const text = message.content.text?.toLowerCase() || '';
      
      // Extract proposal ID
      const idMatch = text.match(/(?:proposal\s*)?#?(\d+)/);
      if (!idMatch) {
        return {
          success: false,
          error: new Error('No proposal ID found'),
          text: '❌ Please specify a proposal ID (e.g., "vote yes on proposal #42" or "vote #42 no")',
        };
      }

      const proposalId = idMatch[1];

      // Extract vote option
      let voteOption: VoteOption;
      if (text.includes('yes')) {
        voteOption = VoteOption.VOTE_OPTION_YES;
      } else if (text.includes('no') && text.includes('veto')) {
        voteOption = VoteOption.VOTE_OPTION_NO_WITH_VETO;
      } else if (text.includes('no')) {
        voteOption = VoteOption.VOTE_OPTION_NO;
      } else if (text.includes('abstain')) {
        voteOption = VoteOption.VOTE_OPTION_ABSTAIN;
      } else {
        return {
          success: false,
          error: new Error('Invalid vote option'),
          text: '❌ Please specify a valid vote option: **yes**, **no**, **abstain**, or **veto**\n\nExample: "vote yes on proposal #42"',
        };
      }

      // Get proposal details first
      let proposal;
      try {
        proposal = await service.getProposal(proposalId);
      } catch (error) {
        return {
          success: false,
          error: new Error('Proposal not found'),
          text: `❌ Proposal #${proposalId} not found or inaccessible`,
        };
      }

      // Check if proposal is in voting period
      if (proposal.status !== 'PROPOSAL_STATUS_VOTING_PERIOD') {
        const status = service.formatProposalStatus(proposal.status);
        return {
          success: false,
          error: new Error('Proposal not in voting period'),
          text: `❌ **Cannot Vote**\n\nProposal #${proposalId} is not in voting period.\nCurrent status: ${status}`,
        };
      }

      const walletAddress = service.getWalletAddress();
      const voteOptionText = Object.keys(VoteOption)[Object.values(VoteOption).indexOf(voteOption)].replace('VOTE_OPTION_', '');
      
      let response = `🗳️ **Voting on Proposal #${proposalId}**\n\n`;
      response += `**${proposal.content?.title || `Proposal ${proposalId}`}**\n\n`;
      response += `👛 Voter: ${walletAddress}\n`;
      response += `✅ Vote: **${voteOptionText}**\n\n`;
      response += `⏳ Processing your vote...`;

      // Send initial response
      if (callback) {
        await callback({
          text: response,
          actions: ['VOTE_ON_PROPOSAL'],
          source: message.content.source,
        });
      }

      // Attempt to vote
      const voteResult = await service.voteOnProposal(proposalId, voteOption);

      if (voteResult.success) {
        const successResponse = `🎉 **Vote Cast Successfully!**\n\n`;
        const finalResponse = successResponse + 
          `📋 Proposal: #${proposalId}\n` +
          `✅ Your Vote: **${voteOptionText}**\n` +
          `📄 Transaction: ${voteResult.txHash}\n` +
          `⛽ Gas Used: ${voteResult.gasUsed}\n\n` +
          `✨ Your vote has been recorded on the SEI blockchain!`;

        return {
          text: finalResponse,
          success: true,
          data: {
            actions: ['VOTE_ON_PROPOSAL'],
            source: message.content.source,
            proposalId,
            voteOption: voteOptionText,
            txHash: voteResult.txHash,
          },
        };
      } else {
        const errorResponse = `❌ **Vote Failed**\n\n` +
          `Error: ${voteResult.error}\n\n` +
          `Please try again or check your wallet configuration.`;

        return {
          success: false,
          error: new Error(voteResult.error || 'Vote failed'),
          text: errorResponse,
        };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to vote';
      const response = `❌ **Voting Error**\n\n${errorMessage}`;
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: response,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'vote yes on proposal #42',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '🎉 **Vote Cast Successfully!**\n\n📋 Proposal: #42\n✅ Your Vote: **YES**\n📄 Transaction: 0xabc123...\n\n✨ Your vote has been recorded on the SEI blockchain!',
          actions: ['VOTE_ON_PROPOSAL'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'vote no with veto on #15',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '🎉 **Vote Cast Successfully!**\n\n📋 Proposal: #15\n✅ Your Vote: **NO_WITH_VETO**\n📄 Transaction: 0xdef456...',
          actions: ['VOTE_ON_PROPOSAL'],
        },
      },
    ],
  ],
};

/**
 * Enhanced Get Validators Action
 */
const getValidatorsAction: Action = {
  name: 'GET_SEI_VALIDATORS',
  similes: ['SEI_VALIDATORS', 'VALIDATORS', 'STAKING', 'SHOW_VALIDATORS'],
  description: 'Get SEI validators with detailed metrics and beautiful formatting',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return text.includes('validator') || 
           text.includes('staking') || 
           text.includes('delegate');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService(SeiGovernanceService.serviceType) as SeiGovernanceService;
      if (!service) {
        throw new Error('SEI governance service not available');
      }

      const text = message.content.text?.toLowerCase() || '';
      let limit = 15;

      // Extract number from message
      const numberMatch = text.match(/\d+/);
      if (numberMatch) {
        limit = Math.min(parseInt(numberMatch[0]), 100);
      }

      const validators = await service.getValidators('BOND_STATUS_BONDED', limit);
      
      if (validators.length === 0) {
        const response = '🏗️ No active validators found.';
        
        if (callback) {
          await callback({
            text: response,
            actions: ['GET_SEI_VALIDATORS'],
            source: message.content.source,
          });
        }

        return { text: response, success: true };
      }

      // Sort by token amount (voting power)
      validators.sort((a, b) => parseInt(b.tokens) - parseInt(a.tokens));

      let response = `⚡ **SEI Validator Network**\n\n`;
      response += `🏗️ Active Validators: ${validators.length}\n\n`;

      validators.forEach((validator, index) => {
        const commission = (parseFloat(validator.commission.commission_rates.rate) * 100).toFixed(2);
        const tokens = service.formatSeiAmount(validator.tokens);
        const moniker = validator.description.moniker || 'Unknown';
        const isJailed = validator.jailed ? ' 🚫' : '';
        
        response += `**${index + 1}. ${moniker}**${isJailed}\n`;
        response += `   💰 Stake: ${tokens} SEI\n`;
        response += `   💸 Commission: ${commission}%\n`;
        response += `   📍 Address: ${validator.operator_address}\n`;
        
        if (validator.description.website) {
          response += `   🌐 ${validator.description.website}\n`;
        }
        
        response += '\n';
      });

      response += `\n💡 *Use "delegate [amount] to [validator_address]" to stake*\n`;
      response += `📊 *Use "validator details [name]" for more info*`;

      if (callback) {
        await callback({
          text: response,
          actions: ['GET_SEI_VALIDATORS'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['GET_SEI_VALIDATORS'],
          source: message.content.source,
          validators,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to get validators';
      const response = `❌ Unable to fetch SEI validators: ${errorMessage}`;
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: response,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Show me top 10 SEI validators',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '⚡ **SEI Validator Network**\n\n🏗️ Active Validators: 10\n\n**1. Figment**\n   💰 Stake: 293,385,598.08 SEI\n   💸 Commission: 5.00%',
          actions: ['GET_SEI_VALIDATORS'],
        },
      },
    ],
  ],
};

/**
 * Delegate Tokens Action
 */
const delegateTokensAction: Action = {
  name: 'DELEGATE_TOKENS',
  similes: ['DELEGATE', 'STAKE', 'DELEGATE_SEI', 'STAKE_SEI'],
  description: 'Delegate SEI tokens to a validator for staking rewards',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return (
      text.includes('delegate') || text.includes('stake')
    ) && /\d+/.test(text); // Contains numbers (amount)
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService(SeiGovernanceService.serviceType) as SeiGovernanceService;
      if (!service) {
        throw new Error('SEI governance service not available');
      }

      if (!service.isWalletConfigured()) {
        const response = '❌ **Wallet Not Configured**\n\nTo delegate tokens, please set your `SEI_MNEMONIC` or `SEI_PRIVATE_KEY` in the environment variables.';
        
        return { text: response, success: false };
      }

      const text = message.content.text || '';
      
      // Extract amount and validator address
      const amountMatch = text.match(/(\d+(?:\.\d+)?)/);
      const validatorMatch = text.match(/(?:to|validator)\s+([a-zA-Z0-9]+)/i);
      
      if (!amountMatch) {
        return {
          success: false,
          error: new Error('No amount specified'),
          text: '❌ Please specify an amount to delegate (e.g., "delegate 100 to seivalidator123...")',
        };
      }

      if (!validatorMatch) {
        return {
          success: false,
          error: new Error('No validator specified'),
          text: '❌ Please specify a validator address (e.g., "delegate 100 to seivalidator123...")',
        };
      }

      const amount = amountMatch[1];
      const validatorAddress = validatorMatch[1];
      
      // Convert SEI to microSEI (1 SEI = 1,000,000 usei)
      const microSeiAmount = (parseFloat(amount) * 1000000).toString();

      let response = `🏦 **Delegating Tokens**\n\n`;
      response += `💰 Amount: ${amount} SEI\n`;
      response += `🏗️ Validator: ${validatorAddress}\n`;
      response += `👛 From: ${service.getWalletAddress()}\n\n`;
      response += `⏳ Processing delegation...`;

      // Send initial response
      if (callback) {
        await callback({
          text: response,
          actions: ['DELEGATE_TOKENS'],
          source: message.content.source,
        });
      }

      // Attempt to delegate
      const delegateResult = await service.delegateTokens(validatorAddress, microSeiAmount);

      if (delegateResult.success) {
        const successResponse = `🎉 **Delegation Successful!**\n\n`;
        const finalResponse = successResponse + 
          `💰 Delegated: ${amount} SEI\n` +
          `🏗️ Validator: ${validatorAddress}\n` +
          `📄 Transaction: ${delegateResult.txHash}\n` +
          `⛽ Gas Used: ${delegateResult.gasUsed}\n\n` +
          `✨ Your tokens are now staked and earning rewards!`;

        return {
          text: finalResponse,
          success: true,
          data: {
            actions: ['DELEGATE_TOKENS'],
            source: message.content.source,
            amount,
            validatorAddress,
            txHash: delegateResult.txHash,
          },
        };
      } else {
        const errorResponse = `❌ **Delegation Failed**\n\n` +
          `Error: ${delegateResult.error}\n\n` +
          `Please check your balance and validator address.`;

        return {
          success: false,
          error: new Error(delegateResult.error || 'Delegation failed'),
          text: errorResponse,
        };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to delegate';
      const response = `❌ **Delegation Error**\n\n${errorMessage}`;
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: response,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'delegate 100 SEI to seivalidator123abc',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '🎉 **Delegation Successful!**\n\n💰 Delegated: 100 SEI\n🏗️ Validator: seivalidator123abc\n📄 Transaction: 0xabc123...',
          actions: ['DELEGATE_TOKENS'],
        },
      },
    ],
  ],
};

/**
 * Get Proposal Details Action
 */
const getProposalDetailsAction: Action = {
  name: 'GET_PROPOSAL_DETAILS',
  similes: ['PROPOSAL_DETAILS', 'PROPOSAL_INFO', 'SHOW_PROPOSAL'],
  description: 'Get detailed information about a specific SEI governance proposal',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return (
  (text.includes('proposal') && text.includes('detail')) ||
  text.includes('proposal #') ||
  /proposal\s+\d+/.test(text)
);

  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService(SeiGovernanceService.serviceType) as SeiGovernanceService;
      if (!service) {
        throw new Error('SEI governance service not available');
      }

      const text = message.content.text || '';
      
      // Extract proposal ID from message
      const idMatch = text.match(/#?(\d+)/);
      if (!idMatch) {
        return {
          success: false,
          error: new Error('No proposal ID found'),
          text: '❌ Please specify a proposal ID (e.g., "proposal details #42")',
        };
      }

      const proposalId = idMatch[1];
      const proposal = await service.getProposal(proposalId);
      
      if (!proposal) {
        return {
          success: false,
          error: new Error('Proposal not found'),
          text: `❌ Proposal #${proposalId} not found`,
        };
      }

      const title = proposal.content?.title || `Proposal ${proposal.proposal_id}`;
      const description = proposal.content?.description || 'No description available';
      const status = service.formatProposalStatus(proposal.status);
      
      let response = `📋 **Proposal #${proposal.proposal_id}**\n\n`;
      response += `**${title}**\n\n`;
      response += `${status}\n\n`;
      
      // Voting information
      if (proposal.voting_start_time && proposal.voting_end_time) {
        const startTime = new Date(proposal.voting_start_time);
        const endTime = new Date(proposal.voting_end_time);
        const now = new Date();
        
        response += `🗓️ **Voting Period**\n`;
        response += `   Start: ${startTime.toLocaleDateString()} ${startTime.toLocaleTimeString()}\n`;
        response += `   End: ${endTime.toLocaleDateString()} ${endTime.toLocaleTimeString()}\n`;
        
        if (proposal.status === 'PROPOSAL_STATUS_VOTING_PERIOD') {
          const timeLeft = Math.ceil((endTime.getTime() - now.getTime()) / (1000 * 60 * 60));
          response += `   ⏰ Time Left: ${timeLeft > 24 ? Math.ceil(timeLeft/24) + ' days' : timeLeft + ' hours'}\n`;
        }
        response += '\n';
      }
      
      // Tally results
      if (proposal.final_tally_result) {
        const tally = proposal.final_tally_result;
        const yes = service.formatSeiAmount(tally.yes || '0');
        const no = service.formatSeiAmount(tally.no || '0');
        const abstain = service.formatSeiAmount(tally.abstain || '0');
        const veto = service.formatSeiAmount(tally.no_with_veto || '0');
        
        response += `📊 **Vote Tally**\n`;
        response += `   ✅ Yes: ${yes} SEI\n`;
        response += `   ❌ No: ${no} SEI\n`;
        response += `   ⚪ Abstain: ${abstain} SEI\n`;
        response += `   🚫 Veto: ${veto} SEI\n\n`;
      }
      
      // Deposit information
      if (proposal.total_deposit && proposal.total_deposit.length > 0) {
        const deposit = proposal.total_deposit[0];
        const depositAmount = service.formatSeiAmount(deposit.amount);
        response += `💰 **Deposit**: ${depositAmount} SEI\n\n`;
      }
      
      // Description (truncated)
      response += `📝 **Description**\n`;
      const truncatedDesc = description.length > 300 
        ? description.substring(0, 300) + '...' 
        : description;
      response += `${truncatedDesc}\n\n`;
      
      if (proposal.status === 'PROPOSAL_STATUS_VOTING_PERIOD') {
        response += `🗳️ *Use "vote ${proposalId} yes/no/abstain/veto" to cast your vote*`;
        
        if (!service.isWalletConfigured()) {
          response += `\n⚠️  *Configure SEI_MNEMONIC or SEI_PRIVATE_KEY to enable voting*`;
        }
      }

      if (callback) {
        await callback({
          text: response,
          actions: ['GET_PROPOSAL_DETAILS'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['GET_PROPOSAL_DETAILS'],
          source: message.content.source,
          proposal,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to get proposal details';
      const response = `❌ Unable to fetch proposal details: ${errorMessage}`;
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: response,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Show me proposal details #42',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '📋 **Proposal #42**\n\n**Increase Block Size Limit**\n\n🗳️ Voting Active\n\n🗓️ **Voting Period**\n   End: 12/25/2024 11:59:59 PM\n   ⏰ Time Left: 5 days',
          actions: ['GET_PROPOSAL_DETAILS'],
        },
      },
    ],
  ],
};

/**
 * Get Wallet Balance Action
 */
const getWalletBalanceAction: Action = {
  name: 'GET_WALLET_BALANCE',
  similes: ['BALANCE', 'WALLET_BALANCE', 'MY_BALANCE', 'CHECK_BALANCE'],
  description: 'Check your SEI wallet balance',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    if (!message.content.text) return false;
    
    const text = message.content.text.toLowerCase();
    return text.includes('balance') || text.includes('wallet');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService(SeiGovernanceService.serviceType) as SeiGovernanceService;
      if (!service) {
        throw new Error('SEI governance service not available');
      }

      if (!service.isWalletConfigured()) {
        const response = '❌ **Wallet Not Configured**\n\nTo check balance, please set your `SEI_MNEMONIC` or `SEI_PRIVATE_KEY` in the environment variables.';
        
        return { text: response, success: false };
      }

      const balance = await service.getWalletBalance();
      const walletAddress = service.getWalletAddress();
      
      let response = `👛 **Wallet Balance**\n\n`;
      response += `📍 Address: ${walletAddress}\n\n`;
      
      if (balance.length === 0) {
        response += `💰 Balance: 0 SEI\n\n`;
        response += `ℹ️ *Your wallet appears to be empty*`;
      } else {
        response += `💰 **Balances:**\n`;
        balance.forEach((coin) => {
          if (coin.denom === 'usei') {
            const seiAmount = service.formatSeiAmount(coin.amount);
            response += `   • ${seiAmount} SEI\n`;
          } else {
            response += `   • ${coin.amount} ${coin.denom}\n`;
          }
        });
      }

      if (callback) {
        await callback({
          text: response,
          actions: ['GET_WALLET_BALANCE'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['GET_WALLET_BALANCE'],
          source: message.content.source,
          balance,
          walletAddress,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to get balance';
      const response = `❌ Unable to fetch wallet balance: ${errorMessage}`;
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        text: response,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'What is my wallet balance?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '👛 **Wallet Balance**\n\n📍 Address: sei1abc123...\n\n💰 **Balances:**\n   • 1,234.56 SEI',
          actions: ['GET_WALLET_BALANCE'],
        },
      },
    ],
  ],
};

export const seiGovernancePlugin: Plugin = {
  name: 'plugin-sei-governance-agent',
  description: 'Full-featured SEI blockchain governance agent with real voting, delegation, and comprehensive proposal management',
  config: {
    SEI_RPC_URL: process.env.SEI_RPC_URL,
    SEI_REST_URL: process.env.SEI_REST_URL,
    SEI_MNEMONIC: process.env.SEI_MNEMONIC,
    SEI_PRIVATE_KEY: process.env.SEI_PRIVATE_KEY,
    SEI_CHAIN_ID: process.env.SEI_CHAIN_ID,
    SEI_ADDRESS_PREFIX: process.env.SEI_ADDRESS_PREFIX,
  },
  async init(config: Record<string, string>) {
    logger.info('🚀 Initializing SEI Governance Agent');
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
      
      logger.info('✅ SEI Governance Agent initialized successfully');
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
    [ModelType.TEXT_SMALL]: async () => {
      return 'I\'m your SEI Governance Agent! 🏛️ I can help you explore proposals, check validators, vote on governance, and manage your staking. Configure SEI_MNEMONIC or SEI_PRIVATE_KEY to enable transaction features!';
    },
    [ModelType.TEXT_LARGE]: async () => {
      return 'Welcome to your comprehensive SEI Governance Agent! 🚀\n\n🏛️ **Governance Features:**\n• View active and historical proposals\n• Detailed proposal analysis and voting stats\n• Cast votes directly from chat with real transactions\n\n⚡ **Validator & Staking:**\n• Real-time validator metrics\n• Commission rates and voting power\n• Delegate and undelegate tokens\n• Check wallet balance\n\n🗳️ **Transaction Setup:**\nSet `SEI_MNEMONIC` or `SEI_PRIVATE_KEY` in your environment to enable real transactions!\n\nTry: "show active proposals", "vote yes on #42", "delegate 100 SEI to validator", or "check my balance"';
    },
  },
  routes: [
    {
      name: 'api-sei-governance-proposals',
      path: '/api/sei/governance/proposals',
      type: 'GET',
      handler: async (req: any, res: any) => {
        try {
          const service = req.runtime.getService(SeiGovernanceService.serviceType) as SeiGovernanceService;
          if (!service) {
            return res.status(500).json({ error: 'SEI governance service not available' });
          }

          const { status, limit = 50 } = req.query;
          const proposals = await service.getProposals(status, parseInt(limit));
          
          res.json({ 
            success: true,
            count: proposals.length,
            proposals 
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            error: 'Failed to get SEI proposals',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'api-sei-governance-validators',
      path: '/api/sei/governance/validators',
      type: 'GET',
      handler: async (req: any, res: any) => {
        try {
          const service = req.runtime.getService(SeiGovernanceService.serviceType) as SeiGovernanceService;
          if (!service) {
            return res.status(500).json({ error: 'SEI governance service not available' });
          }

          const { status = 'BOND_STATUS_BONDED', limit = 100 } = req.query;
          const validators = await service.getValidators(status, parseInt(limit));
          
          res.json({ 
            success: true,
            count: validators.length,
            validators 
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            error: 'Failed to get SEI validators',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'api-sei-wallet-balance',
      path: '/api/sei/wallet/balance',
      type: 'GET',
      handler: async (req: any, res: any) => {
        try {
          const service = req.runtime.getService(SeiGovernanceService.serviceType) as SeiGovernanceService;
          if (!service) {
            return res.status(500).json({ error: 'SEI governance service not available' });
          }

          if (!service.isWalletConfigured()) {
            return res.status(400).json({ error: 'Wallet not configured' });
          }

          const balance = await service.getWalletBalance();
          const walletAddress = service.getWalletAddress();
          
          res.json({ 
            success: true,
            walletAddress,
            balance 
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            error: 'Failed to get wallet balance',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  ],
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (params: MessagePayload) => {
        logger.debug('MESSAGE_RECEIVED event received for SEI governance');
        logger.debug({ message: params.message }, 'Message:');
      },
    ],
  },
  services: [SeiGovernanceService],
  actions: [
    getProposalsAction, 
    getValidatorsAction, 
    getProposalDetailsAction, 
    voteOnProposalAction,
    delegateTokensAction,
    getWalletBalanceAction
  ],
  providers: [],
};

export default seiGovernancePlugin;
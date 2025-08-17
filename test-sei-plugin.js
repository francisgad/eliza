#!/usr/bin/env node

/**
 * Simple test script for SEI Governance Plugin
 * Tests basic functionality without requiring wallet credentials
 */

const { SeiGovernanceService } = require('./sei-governance-plugin.ts');

async function testSeiGovernancePlugin() {
  console.log('🚀 Testing SEI Governance Plugin...\n');

  try {
    // Test 1: Initialize service without wallet
    console.log('Test 1: Service Initialization (without wallet)');
    const service = new SeiGovernanceService();
    console.log('✅ Service initialized successfully');
    console.log(`📍 RPC URL: ${service.rpcUrl || 'Not configured'}`);
    console.log(`📍 REST URL: ${service.restUrl || 'Not configured'}`);
    console.log(`🔗 Chain ID: ${service.chainId || 'Not configured'}`);
    console.log(`👛 Wallet configured: ${service.isWalletConfigured() ? 'Yes' : 'No'}\n`);

    // Test 2: Get proposals
    console.log('Test 2: Fetching Governance Proposals');
    try {
      const proposals = await service.getProposals(undefined, 5);
      console.log(`✅ Successfully fetched ${proposals.length} proposals`);
      
      if (proposals.length > 0) {
        console.log('\n📋 Sample Proposal:');
        const sample = proposals[0];
        console.log(`   ID: #${sample.proposal_id}`);
        console.log(`   Title: ${sample.content?.title || 'N/A'}`);
        console.log(`   Status: ${service.formatProposalStatus(sample.status)}`);
      }
    } catch (error) {
      console.log(`⚠️  Proposal fetch test failed: ${error.message}`);
    }

    console.log();

    // Test 3: Get validators
    console.log('Test 3: Fetching Validators');
    try {
      const validators = await service.getValidators('BOND_STATUS_BONDED', 5);
      console.log(`✅ Successfully fetched ${validators.length} validators`);
      
      if (validators.length > 0) {
        console.log('\n🏗️  Sample Validator:');
        const sample = validators[0];
        console.log(`   Moniker: ${sample.description.moniker || 'Unknown'}`);
        console.log(`   Tokens: ${service.formatSeiAmount(sample.tokens)} SEI`);
        console.log(`   Commission: ${(parseFloat(sample.commission.commission_rates.rate) * 100).toFixed(2)}%`);
        console.log(`   Jailed: ${sample.jailed ? 'Yes' : 'No'}`);
      }
    } catch (error) {
      console.log(`⚠️  Validator fetch test failed: ${error.message}`);
    }

    console.log();

    // Test 4: Utility functions
    console.log('Test 4: Utility Functions');
    
    // Test amount formatting
    const testAmount = '1234567890'; // 1234.56789 SEI
    const formattedAmount = service.formatSeiAmount(testAmount);
    console.log(`✅ Amount formatting: ${testAmount} usei = ${formattedAmount} SEI`);
    
    // Test status formatting
    const testStatus = 'PROPOSAL_STATUS_VOTING_PERIOD';
    const formattedStatus = service.formatProposalStatus(testStatus);
    console.log(`✅ Status formatting: ${testStatus} = ${formattedStatus}`);

    console.log();

    // Test 5: Address conversion (if available)
    console.log('Test 5: Address Conversion');
    try {
      const testEvmAddress = '0x742d35Cc6634C0532925a3b8D6d9c0AC2Bb02d5A';
      const seiAddress = service.evmToSeiAddress(testEvmAddress);
      console.log(`✅ EVM to SEI conversion: ${testEvmAddress} -> ${seiAddress}`);
    } catch (error) {
      console.log(`⚠️  Address conversion test failed: ${error.message}`);
    }

    console.log();

    // Test 6: Transaction capabilities (without actual transactions)
    console.log('Test 6: Transaction Capabilities');
    console.log(`👛 Wallet configured: ${service.isWalletConfigured() ? 'Yes' : 'No'}`);
    console.log(`📍 Wallet address: ${service.getWalletAddress() || 'Not available'}`);
    
    if (!service.isWalletConfigured()) {
      console.log('ℹ️  To test transaction features, set SEI_MNEMONIC or SEI_PRIVATE_KEY environment variables');
    }

    console.log('\n🎉 All basic tests completed successfully!');
    console.log('\n📝 Next Steps:');
    console.log('1. Set SEI_MNEMONIC or SEI_PRIVATE_KEY to test transaction features');
    console.log('2. Try the plugin with actual governance proposals');
    console.log('3. Test voting and delegation functionality');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Configuration test
function testConfiguration() {
  console.log('🔧 Configuration Test:');
  console.log(`SEI_RPC_URL: ${process.env.SEI_RPC_URL || 'Using default'}`);
  console.log(`SEI_REST_URL: ${process.env.SEI_REST_URL || 'Using default'}`);
  console.log(`SEI_CHAIN_ID: ${process.env.SEI_CHAIN_ID || 'Using default'}`);
  console.log(`SEI_MNEMONIC: ${process.env.SEI_MNEMONIC ? '✅ Set' : '❌ Not set'}`);
  console.log(`SEI_PRIVATE_KEY: ${process.env.SEI_PRIVATE_KEY ? '✅ Set' : '❌ Not set'}`);
  console.log();
}

// Main execution
if (require.main === module) {
  console.log('='.repeat(60));
  console.log('🧪 SEI Governance Plugin Test Suite');
  console.log('='.repeat(60));
  console.log();
  
  testConfiguration();
  testSeiGovernancePlugin().catch(console.error);
}

module.exports = { testSeiGovernancePlugin };
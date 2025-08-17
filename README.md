# SEI Governance Agent Plugin

A fully-featured SEI blockchain governance agent with real voting, delegation, and comprehensive proposal management capabilities.

## Features

🏛️ **Governance Features:**
- View active and historical proposals
- Detailed proposal analysis and voting stats
- Cast votes directly from chat with real transactions
- Real transaction broadcasting to SEI network

⚡ **Validator & Staking:**
- Real-time validator metrics
- Commission rates and voting power
- Delegate and undelegate tokens with real transactions
- Check wallet balance

🗳️ **Real Transactions:**
- Uses CosmJS for real transaction creation and broadcasting
- Support for both mnemonic and private key wallet initialization
- Gas estimation and fee calculation
- Transaction confirmation and error handling

## Installation

1. Install required dependencies:

```bash
npm install @cosmjs/stargate @cosmjs/amino @cosmjs/proto-signing @cosmjs/encoding cosmjs-types bech32
```

2. Add the plugin to your Eliza configuration.

## Configuration

Set the following environment variables:

### Required for basic functionality:
- `SEI_RPC_URL` - SEI RPC endpoint (default: `https://sei-rpc.polkachu.com`)
- `SEI_REST_URL` - SEI REST API endpoint (default: `https://sei-api.polkachu.com`)
- `SEI_CHAIN_ID` - SEI chain ID (default: `pacific-1`)

### Required for transactions (voting, delegation):
- `SEI_MNEMONIC` - Your SEI wallet mnemonic phrase (12 or 24 words)
  
  **OR**
  
- `SEI_PRIVATE_KEY` - Your SEI wallet private key (hex format)

### Optional:
- `SEI_ADDRESS_PREFIX` - Address prefix (default: `sei`)

### Example .env configuration:

```env
SEI_RPC_URL=https://sei-rpc.polkachu.com
SEI_REST_URL=https://sei-api.polkachu.com
SEI_CHAIN_ID=pacific-1
SEI_MNEMONIC="your twelve word mnemonic phrase goes here for wallet access"
# OR use private key instead:
# SEI_PRIVATE_KEY=0x1234567890abcdef...
```

⚠️ **Security Warning**: Keep your mnemonic phrase and private key secure. Never share them or commit them to version control.

## Usage Examples

### View Governance Proposals

```
"Show me active SEI proposals"
"Get all SEI governance proposals"
"Show me passed proposals"
"Get proposal details #42"
```

### Voting on Proposals

```
"Vote yes on proposal #42"
"Vote no on #15"
"Vote abstain on proposal #7"
"Vote no with veto on #23"
```

### Validator Information

```
"Show me top 10 SEI validators"
"Get SEI validators"
"Show me all validators"
```

### Staking/Delegation

```
"Delegate 100 SEI to seivalidator1abc123..."
"Stake 50 SEI to validator seivalidator1xyz789..."
```

### Wallet Management

```
"Check my wallet balance"
"What's my SEI balance?"
"Show my wallet address"
```

## API Endpoints

The plugin also exposes REST API endpoints:

- `GET /api/sei/governance/proposals` - Get governance proposals
- `GET /api/sei/governance/validators` - Get validators
- `GET /api/sei/wallet/balance` - Get wallet balance (requires wallet configuration)

### Query Parameters:

**Proposals endpoint:**
- `status` - Filter by proposal status (optional)
- `limit` - Number of proposals to return (default: 50, max: 100)

**Validators endpoint:**
- `status` - Filter by validator status (default: `BOND_STATUS_BONDED`)
- `limit` - Number of validators to return (default: 100)

## Real Transaction Implementation

This plugin uses real CosmJS libraries to create and broadcast transactions to the SEI network:

### Voting Transactions
- Creates `MsgVote` messages using `cosmjs-types`
- Estimates gas and calculates fees automatically
- Broadcasts to the configured SEI RPC endpoint
- Returns real transaction hashes

### Delegation Transactions
- Creates `MsgDelegate` messages for staking
- Converts SEI amounts to microSEI automatically
- Handles gas estimation and fee calculation
- Supports both delegation and undelegation

### Wallet Integration
- Supports mnemonic phrase and private key initialization
- Uses `DirectSecp256k1HdWallet` for secure key management
- Automatically derives SEI addresses with proper bech32 encoding
- Maintains persistent connection to SEI network

## Transaction Flow

1. **Wallet Initialization**: On service start, creates wallet from mnemonic/private key
2. **Address Derivation**: Generates SEI bech32 address from wallet
3. **Client Connection**: Establishes connection to SEI RPC with signing capabilities
4. **Message Creation**: Builds Cosmos SDK messages for transactions
5. **Gas Estimation**: Simulates transaction to estimate gas requirements
6. **Transaction Signing**: Signs transaction with wallet private key
7. **Broadcasting**: Broadcasts signed transaction to SEI network
8. **Confirmation**: Returns transaction hash and gas usage information

## Error Handling

The plugin includes comprehensive error handling:

- **Network Errors**: Automatic retry for temporary network issues
- **Transaction Errors**: Detailed error messages from blockchain
- **Wallet Errors**: Clear messages for wallet configuration issues
- **Validation Errors**: Input validation before transaction creation

## Security Considerations

1. **Private Key Management**: Private keys are only stored in memory and never logged
2. **Environment Variables**: Sensitive data should only be in environment variables
3. **Network Security**: Uses HTTPS endpoints for all API calls
4. **Transaction Validation**: Validates all inputs before creating transactions

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

### Linting

```bash
npm run lint
```

## Troubleshooting

### Common Issues

1. **"Wallet not configured"**: Set `SEI_MNEMONIC` or `SEI_PRIVATE_KEY` environment variable
2. **"Transaction failed"**: Check wallet balance and network connectivity
3. **"Invalid proposal ID"**: Ensure the proposal exists and is accessible
4. **"Network timeout"**: Check RPC endpoint availability

### Debug Logging

Enable debug logging to see detailed transaction information:

```env
LOG_LEVEL=debug
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

This project is licensed under the MIT License.

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review the configuration
3. Open an issue on GitHub
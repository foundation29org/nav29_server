# Nav29 Server

Backend server for the Nav29 platform, designed to improve medical information management through the use of generative artificial intelligence.

## Related Repositories

- **Client Application**: [https://github.com/foundation29org/nav29_client](https://github.com/foundation29org/nav29_client)

## Development Environment Setup

### Prerequisites
- Node.js (recommended version: 22.13.1)
- MongoDB
- Azure account (for services like OpenAI, Blob Storage, etc.)
- Accounts in various AI services (OpenAI, Anthropic, Google, etc.)

### Installation

1. Clone this repository:
```bash
git clone https://github.com/your-username/nav29-server.git
cd nav29-server
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
   - Create a `.env` file in the project root based on `.env.example`
   - Fill in all variables with your own credentials

4. Start the server in development mode:
```bash
npm run servedev
```

## Secure Credential Management

### Important: Credential Security
- The `config.js` file contains references to environment variables for all credentials
- **NEVER** upload real credentials to GitHub
- Make sure `config.js` is included in `.gitignore` if it contains hardcoded credentials
- Use environment variables for all credentials in production environments

### Setting up environment variables in production
For production environments (such as Azure App Service), configure all necessary environment variables in the Configuration/Application settings section.

## Project Structure

- `/controllers`: Business logic and API controllers
- `/models`: Data models and MongoDB schemas
- `/routes`: API route definitions
- `/services`: Services for interacting with external APIs
- `/utils`: Utilities and helper functions

## Main Features

- Medical report management
- Intelligent summaries using AI
- Analysis and information extraction using LLMs
- Conversational interface
- Notes manager
- Data sharing
- Appointment and important event reminders

## License

MIT
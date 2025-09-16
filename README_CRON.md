# SQP Cron API - Documentation

This API provides legacy cron endpoints for SQP (Search Query Performance) operations.

## Available Endpoints

### 1. Request Reports
**GET** `/cron/request`

Request SQP reports for a specific seller.

**Parameters:**
- `userId` (required) - User ID
- `sellerId` (required) - Seller ID

**Example:**
```
GET http://localhost:3001/cron/request?userId=3&sellerId=71
```

**Response:**
```json
{
  "success": true,
  "message": "Reports requested successfully",
  "data": {
    "requestedReports": 5,
    "sellerId": "71"
  }
}
```

### 2. Check Report Status
**GET** `/cron/status`

Check the status of requested reports.

**Parameters:**
- `userId` (required) - User ID

**Example:**
```
GET http://localhost:3001/cron/status?userId=3
```

**Response:**
```json
{
  "success": true,
  "message": "Report status retrieved",
  "data": {
    "pending": 2,
    "completed": 3,
    "failed": 0,
    "total": 5
  }
}
```

### 3. Download Reports
**GET** `/cron/download`

Download completed reports.

**Parameters:**
- `userId` (required) - User ID

**Example:**
```
GET http://localhost:3001/cron/download?userId=3
```

**Response:**
```json
{
  "success": true,
  "message": "Reports downloaded successfully",
  "data": {
    "downloadedFiles": 3,
    "totalSize": "2.5MB"
  }
}
```

### 4. Process JSON Files
**GET** `/cron/process-json`

Process downloaded JSON files and store metrics.

**Parameters:**
- `userId` (required) - User ID

**Example:**
```
GET http://localhost:3001/cron/process-json?userId=3
```

**Response:**
```json
{
  "success": true,
  "message": "JSON files processed successfully",
  "data": {
    "processedFiles": 3,
    "totalRecords": 1500,
    "successfulRecords": 1485,
    "failedRecords": 15
  }
}
```

## Error Responses

All endpoints return standardized error responses:

```json
{
  "success": false,
  "message": "Error description",
  "error": "ErrorType",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Common Error Codes

- `400` - Bad Request (invalid parameters)
- `404` - Not Found (endpoint not found)
- `500` - Internal Server Error

## Rate Limiting

- 50 requests per 15 minutes per IP address
- Rate limit headers included in responses:
  - `X-RateLimit-Limit`
  - `X-RateLimit-Remaining`
  - `X-RateLimit-Reset`

## Security

- Input sanitization and validation
- Security headers (XSS protection, etc.)
- Request logging
- No authentication required (simplified for cron usage)

## Usage Examples

### Complete Workflow

1. **Request Reports:**
   ```bash
   curl "http://localhost:3001/cron/request?userId=3&sellerId=71"
   ```

2. **Check Status:**
   ```bash
   curl "http://localhost:3001/cron/status?userId=3"
   ```

3. **Download Reports:**
   ```bash
   curl "http://localhost:3001/cron/download?userId=3"
   ```

4. **Process JSON Files:**
   ```bash
   curl "http://localhost:3001/cron/process-json?userId=3"
   ```

### JavaScript/Node.js Example

```javascript
const axios = require('axios');

const baseURL = 'http://localhost:3001';

async function runCronWorkflow(userId, sellerId) {
  try {
    // 1. Request reports
    console.log('Requesting reports...');
    const requestResponse = await axios.get(`${baseURL}/cron/request`, {
      params: { userId, sellerId }
    });
    console.log('Request result:', requestResponse.data);

    // 2. Check status
    console.log('Checking status...');
    const statusResponse = await axios.get(`${baseURL}/cron/status`, {
      params: { userId }
    });
    console.log('Status:', statusResponse.data);

    // 3. Download reports
    console.log('Downloading reports...');
    const downloadResponse = await axios.get(`${baseURL}/cron/download`, {
      params: { userId }
    });
    console.log('Download result:', downloadResponse.data);

    // 4. Process JSON files
    console.log('Processing JSON files...');
    const processResponse = await axios.get(`${baseURL}/cron/process-json`, {
      params: { userId }
    });
    console.log('Process result:', processResponse.data);

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

// Run the workflow
runCronWorkflow(3, 71);
```

### Python Example

```python
import requests

base_url = 'http://localhost:3001'

def run_cron_workflow(user_id, seller_id):
    try:
        # 1. Request reports
        print('Requesting reports...')
        request_response = requests.get(f'{base_url}/cron/request', 
                                      params={'userId': user_id, 'sellerId': seller_id})
        print('Request result:', request_response.json())

        # 2. Check status
        print('Checking status...')
        status_response = requests.get(f'{base_url}/cron/status', 
                                     params={'userId': user_id})
        print('Status:', status_response.json())

        # 3. Download reports
        print('Downloading reports...')
        download_response = requests.get(f'{base_url}/cron/download', 
                                       params={'userId': user_id})
        print('Download result:', download_response.json())

        # 4. Process JSON files
        print('Processing JSON files...')
        process_response = requests.get(f'{base_url}/cron/process-json', 
                                      params={'userId': user_id})
        print('Process result:', process_response.json())

    except requests.exceptions.RequestException as e:
        print('Error:', e)

# Run the workflow
run_cron_workflow(3, 71)
```

## Health Check

**GET** `/health`

Check if the API is running.

**Example:**
```
GET http://localhost:3001/health
```

**Response:**
```json
{
  "success": true,
  "message": "Service is healthy",
  "data": {
    "status": "healthy",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "uptime": 3600,
    "memory": {
      "rss": 50000000,
      "heapTotal": 20000000,
      "heapUsed": 15000000,
      "external": 1000000
    },
    "version": "v18.0.0",
    "database": {
      "status": "healthy"
    }
  }
}
```

## Project Structure

```
mixshift-sqp-api/
├── src/
│   ├── controllers/
│   │   └── sqpCronApiController.js    # Cron API controller
│   ├── routes/
│   │   └── cronRoutes.js              # Cron routes
│   ├── services/
│   │   └── sqpFileProcessingService.js # File processing service
│   ├── models/
│   │   ├── masterModel.js             # Master data model
│   │   └── sellerModel.js             # Seller model
│   ├── helpers/
│   │   └── sqpHelpers.js              # Helper functions
│   ├── middleware/
│   │   ├── authMiddleware.js          # Authentication middleware
│   │   └── responseHandlers.js        # Response handlers
│   └── db/
│       └── tenant.js                  # Database connection
├── server.js                          # Main server file
└── README_CRON.md                     # This documentation
```

## Getting Started

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Create a `.env` file with your database and API configurations.

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Test the endpoints:**
   Use the examples above to test the cron endpoints.

## Notes

- This API is designed for cron job usage and doesn't require authentication
- All endpoints are GET requests for simplicity
- The API handles file processing and database operations automatically
- Rate limiting is applied to prevent abuse
- All requests are logged for monitoring purposes

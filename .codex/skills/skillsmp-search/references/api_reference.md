# SkillsMP API Reference

## Setup

To use the SkillsMP API, you need to:

1. Visit https://skillsmp.com/docs/api
2. Click "Generate API Key" to obtain your API key
3. Set the API key as an environment variable:

**Linux/Mac:**
```bash
export SKILLSMP_API_KEY='your_api_key_here'
```

**Windows:**
```cmd
set SKILLSMP_API_KEY=your_api_key_here
```

The search script will automatically read the API key from this environment variable.

## Base URL
```
https://skillsmp.com/api/v1
```

## Authentication
All API requests require a Bearer token in the Authorization header:
```
Authorization: Bearer YOUR_API_KEY_HERE
```

## Endpoints

### GET /skills/search
Keyword-based search for skills.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| q | string | ✓ | Search query |
| page | number | - | Page number (default: 1) |
| limit | number | - | Items per page (default: 20, max: 100) |
| sortBy | string | - | Sort method: 'stars' or 'recent' |

**Example Request:**
```bash
curl -X GET "https://skillsmp.com/api/v1/skills/search?q=SEO&page=1&limit=20&sortBy=stars" \
  -H "Authorization: Bearer YOUR_API_KEY_HERE"
```

**Response Format:**
```json
{
  "success": true,
  "skills": [
    {
      "name": "skill-name",
      "description": "skill description",
      "stars": 42,
      "author": "username",
      "url": "https://skillsmp.com/skills/skill-name"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150
  }
}
```

### GET /skills/ai-search
AI semantic search powered by Cloudflare AI.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| q | string | ✓ | Natural language search query |

**Example Request:**
```bash
curl -X GET "https://skillsmp.com/api/v1/skills/ai-search?q=How+to+create+a+web+scraper" \
  -H "Authorization: Bearer YOUR_API_KEY_HERE"
```

**Response Format:**
```json
{
  "success": true,
  "skills": [
    {
      "name": "skill-name",
      "description": "skill description",
      "relevance": 0.95,
      "url": "https://skillsmp.com/skills/skill-name"
    }
  ]
}
```

## Error Handling

**Error Response Format:**
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error description"
  }
}
```

**Error Codes:**
| Code | HTTP Status | Description |
|------|-------------|-------------|
| MISSING_API_KEY | 401 | API key not provided |
| INVALID_API_KEY | 401 | Invalid API key |
| MISSING_QUERY | 400 | Missing required query parameter |
| INTERNAL_ERROR | 500 | Internal server error |

## Usage Examples

### Keyword Search for Web Development Skills
```bash
python scripts/skillsmp_search.py keyword "web development" 1 20 stars
```

### AI Search for Specific Use Case
```bash
python scripts/skillsmp_search.py ai "How to build a chatbot with natural language understanding"
```

### Paginated Search
```bash
# Page 1
python scripts/skillsmp_search.py keyword "automation" 1 10 recent

# Page 2
python scripts/skillsmp_search.py keyword "automation" 2 10 recent
```

## Best Practices

1. **Choose the Right Search Method:**
   - Use keyword search for exact terms and filtering
   - Use AI search for natural language queries and semantic matching

2. **Pagination:**
   - Default limit is 20, maximum is 100
   - Use appropriate page size for performance

3. **Sorting:**
   - 'stars' - Most popular skills first
   - 'recent' - Newest skills first

4. **Error Handling:**
   - Always check the 'success' field in responses
   - Handle network errors gracefully
   - Implement retry logic for transient failures

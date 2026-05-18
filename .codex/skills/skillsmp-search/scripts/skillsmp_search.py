#!/usr/bin/env python3
"""
SkillsMP API Search Script
Provides keyword and AI semantic search capabilities for SkillsMP skills marketplace.
"""

import requests
import sys
import json
import os
from typing import Optional, Dict, Any

API_BASE_URL = "https://skillsmp.com/api/v1"
API_KEY = os.getenv("SKILLSMP_API_KEY", "")


def keyword_search(
    query: str,
    page: int = 1,
    limit: int = 20,
    sort_by: Optional[str] = None
) -> Dict[str, Any]:
    """
    Search skills using keywords.

    Args:
        query: Search query string
        page: Page number (default: 1)
        limit: Items per page (default: 20, max: 100)
        sort_by: Sort method ('stars' or 'recent')

    Returns:
        API response as dictionary
    """
    url = f"{API_BASE_URL}/skills/search"
    headers = {"Authorization": f"Bearer {API_KEY}"}
    params = {
        "q": query,
        "page": page,
        "limit": limit
    }

    if sort_by:
        params["sortBy"] = sort_by

    try:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "error": {
                "code": "REQUEST_FAILED",
                "message": str(e)
            }
        }


def ai_search(query: str) -> Dict[str, Any]:
    """
    AI semantic search powered by Cloudflare AI.

    Args:
        query: Natural language search query

    Returns:
        API response as dictionary
    """
    url = f"{API_BASE_URL}/skills/ai-search"
    headers = {"Authorization": f"Bearer {API_KEY}"}
    params = {"q": query}

    try:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "error": {
                "code": "REQUEST_FAILED",
                "message": str(e)
            }
        }


def format_results(data: Dict[str, Any], search_type: str) -> str:
    """
    Format API response for display.

    Args:
        data: API response dictionary
        search_type: Type of search ('keyword' or 'ai')

    Returns:
        Formatted string output
    """
    if not data.get("success", True):
        error = data.get("error", {})
        return f"❌ Error ({error.get('code', 'UNKNOWN')}): {error.get('message', 'Unknown error')}"

    output = [f"\n{'='*60}"]
    output.append(f"Search Type: {search_type.upper()}")
    output.append(f"{'='*60}\n")

    # Handle different response structures
    # AI search returns nested structure: data.data[].skill
    # Keyword search returns flat: skills[]
    if search_type == "ai":
        results = data.get("data", {}).get("data", [])
        if not results:
            return "\n".join(output) + "No results found."

        for idx, item in enumerate(results, 1):
            skill = item.get("skill", {})
            score = item.get("score", 0)

            output.append(f"{idx}. {skill.get('name', 'Unnamed Skill')}")
            output.append(f"   Description: {skill.get('description', 'No description')}")
            output.append(f"   Author: {skill.get('author', 'Unknown')}")
            output.append(f"   Stars: {skill.get('stars', 0)}")
            output.append(f"   Relevance Score: {score:.3f}")
            output.append(f"   URL: {skill.get('skillUrl', '')}")
            output.append("")
    else:
        # Keyword search - also uses nested structure: data.skills[]
        skills = data.get("data", {}).get("skills", [])
        if not skills:
            return "\n".join(output) + "No results found."

        # Add pagination info
        pagination = data.get("data", {}).get("pagination", {})
        if pagination:
            output.append(f"Page {pagination.get('page', 1)} of {pagination.get('totalPages', 1)} (Total: {pagination.get('total', 0)} skills)\n")

        for idx, skill in enumerate(skills, 1):
            output.append(f"{idx}. {skill.get('name', 'Unnamed Skill')}")
            output.append(f"   Description: {skill.get('description', 'No description')}")
            output.append(f"   Author: {skill.get('author', 'Unknown')}")
            output.append(f"   Stars: {skill.get('stars', 0)}")
            output.append(f"   URL: {skill.get('skillUrl', skill.get('url', ''))}")
            output.append("")

    return "\n".join(output)


def main():
    """Main CLI interface."""
    # Check if API key is set
    if not API_KEY:
        print("❌ Error: SKILLSMP_API_KEY environment variable is not set.")
        print("\nPlease set your API key:")
        print("  export SKILLSMP_API_KEY='your_api_key_here'")
        print("\nOr on Windows:")
        print("  set SKILLSMP_API_KEY=your_api_key_here")
        sys.exit(1)

    if len(sys.argv) < 3:
        print("Usage:")
        print("  Keyword search: python skillsmp_search.py keyword <query> [page] [limit] [sortBy]")
        print("  AI search:      python skillsmp_search.py ai <query>")
        print("\nExamples:")
        print("  python skillsmp_search.py keyword 'web scraper' 1 20 stars")
        print("  python skillsmp_search.py ai 'How to create a chatbot'")
        sys.exit(1)

    search_type = sys.argv[1].lower()
    query = sys.argv[2]

    if search_type == "keyword":
        page = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        limit = int(sys.argv[4]) if len(sys.argv) > 4 else 20
        sort_by = sys.argv[5] if len(sys.argv) > 5 else None

        result = keyword_search(query, page, limit, sort_by)
        print(format_results(result, "keyword"))

    elif search_type == "ai":
        result = ai_search(query)
        print(format_results(result, "ai"))

    else:
        print(f"❌ Invalid search type: {search_type}")
        print("Use 'keyword' or 'ai'")
        sys.exit(1)

    # Print raw JSON for debugging
    if "--json" in sys.argv:
        print("\n" + "="*60)
        print("RAW JSON RESPONSE:")
        print("="*60)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

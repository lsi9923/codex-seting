---
name: heretic
description: Use when the user asks to install, run, configure, evaluate, or apply Heretic, heretic-llm, abliteration, uncensoring, censorship removal, refusal removal, LoRA-based model modification, or refusal evaluation for local or Hugging Face language models. Prefer this skill for any project when the task mentions Heretic, uncensor, abliterate, abliterated, refusal direction, model refusal, or censorship removal.
---

# Heretic CLI Workflow

Heretic is installed globally for this user as a `uv tool`.

## Default Tool

- CLI: PATH command `heretic`
- Current primary executable: `C:\Users\imda0\AppData\Local\Programs\Python\Python313\Scripts\heretic.exe`
- Secondary uv-tool executable: `C:\Users\imda0\.local\bin\heretic.exe`
- System Python package: `heretic-llm==1.3.0` in Python 3.13
- Compatible system Python torch: `torch==2.10.0+cpu`
- Tool package: `heretic-llm`
- Installation manager: `uv tool`

## Before Running

Use PowerShell and confirm the global command is visible:

```powershell
python -m pip show heretic-llm
Get-Command heretic
heretic --help
```

If the command is missing, check:

```powershell
uv tool list
uv tool dir
```

## Project Rule

- Use the global Heretic tool from any project folder.
- Do not install Heretic into a project `.venv` unless the user explicitly asks for a project-local install.
- If a project uses its own `.venv`, verify `python -m pip show heretic-llm` inside that environment before assuming the package is available there.
- Heretic applies to Hugging Face model IDs or local model paths. It does not modify Codex or OpenAI hosted model settings.
- For model runs, create or reuse a project-local `config.toml` only when the model target and output location are clear.

## Common Command Shape

```powershell
heretic --model <huggingface-model-id-or-local-model-path>
```

Add resource flags only after checking the machine and model size, for example:

```powershell
heretic --model <model> --quantization bnb_4bit --device-map auto
```

# KsanaDock GameMaker

[简体中文](./README.zh-CN.md) | [English](./README.en.md)

`KsanaDock GameMaker` is an AI-assisted development toolkit for the Godot Editor. It combines in-editor chat, context capture, editor bridging, and a local agent service so you can ask questions, pass project context, and trigger editor-side actions without leaving Godot.

## Overview

This repository currently includes three main parts:

- `addons/ksanadock`
	- Provides the chat dock, login UI, profile UI, output capture, and context collection
- `addons/ksanadock_bridge`
	- Runs as a Godot editor plugin, starts the local WebSocket bridge, and communicates with the agent service
- `addons/ksanadock_bridge/service`
	- A Node.js-based agent service responsible for the agent loop, tool registration, skill loading, and task execution

## Key Features

- AI chat dock inside the Godot Editor
- Login flow, session refresh, and basic profile display
- Context capture from the script editor, filesystem, and output panel
- Built-in terminal panel with tab management
- Local bridge that forwards requests between Godot and the agent service
- Editor-side actions exposed through the bridge, including:
	- Reading the scene tree
	- Creating nodes
	- Deleting nodes
	- Setting node properties
	- Creating new scenes
	- Instantiating scenes
	- Saving scenes
	- Searching project assets

## Status

- Plugin version: `KsanaDock 0.1.0`
- Bridge version: `KsanaDock Bridge 0.1`
- The project is still in an early stage, so APIs, configuration, and startup flow may continue to evolve
- The current auto-start logic for the bridge is based on `cmd.exe`, so the present setup is primarily suited for Windows

## Requirements

- Godot `4.6`
- Node.js
- `npx`
- A working `npx tsx` command
- Network access to the services used by the project

If `npx tsx` is not available in your environment, install the required dependency before starting the agent service.

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/KsanaDock/GameMaker.git
cd GameMaker
```

### 2. Install agent service dependencies

```bash
cd addons/ksanadock_bridge/service
npm install
```

### 3. Configure environment variables

Copy `addons/ksanadock_bridge/service/.env.example` to `.env` and fill in the values you need.

The current example includes:

- `OPENROUTER_API_KEY`
- `SITE_URL`
- `SITE_NAME`

### 4. Open the project in Godot

Open the repository root and load `project.godot` with Godot.

The project already enables these two editor plugins by default:

- `res://addons/ksanadock/plugin.cfg`
- `res://addons/ksanadock_bridge/plugin.cfg`

If you are integrating the plugin into your own Godot project, make sure both plugins are enabled.

### 5. Start and connect

After the project opens, `KsanaDock Bridge` will try to automatically:

- Start the local agent service
- Listen on local port `9080`
- Connect to the agent service over WebSocket

The current agent service startup command is:

```bash
npx tsx src/index.ts --project-root <your-project-directory>
```

If auto-start fails, check the following first:

- Dependencies in `addons/ksanadock_bridge/service` are installed
- `npx tsx` is available on your machine
- `ksanadock/agent/service_path` in Project Settings needs to be set manually

## How To Use

### AI Chat

- Open the `Chat` dock on the right side
- Log in and send natural-language requests
- Messages are forwarded through the bridge to the local agent service

### Context References

- Select code in the script editor and send it through the context menu
- Capture selected output text or clipboard content as context
- Combine files, text, and code references into a single prompt

### Scene And Editor Actions

The bridge already exposes a set of Godot editor operations that the agent can call, such as:

- Inspecting the current scene tree
- Creating or deleting nodes
- Updating node properties
- Creating and saving scenes
- Searching resources inside the project

### Terminal Panel

- The bottom panel provides a multi-tab terminal view
- Tabs can be added, cleared, or closed

## Project Structure

```text
GameMaker/
├─ addons/
│  ├─ ksanadock/
│  │  ├─ api/
│  │  ├─ ui/
│  │  ├─ theme/
│  │  └─ plugin.cfg
│  └─ ksanadock_bridge/
│     ├─ service/
│     │  ├─ src/
│     │  ├─ skills/
│     │  └─ package.json
│     ├─ ksanadock_bridge.gd
│     └─ plugin.cfg
└─ project.godot
```

## Good Fit For

- AI-assisted development directly inside the Godot Editor
- Explaining code, logs, and files with natural-language context
- Letting a local agent help with scene editing and project resource lookup
- Extending an experimental foundation for a Godot AI editor plugin and bridge system

## Open Source

- Repository: <https://github.com/KsanaDock/GameMaker.git>
- License: MIT

## Acknowledgements

- Thanks to the Godot Engine team for building and maintaining an open, creator-friendly game engine.
- Thanks to the author of the `godogen` project for the ideas and inspiration around Godot-related tooling and workflows.

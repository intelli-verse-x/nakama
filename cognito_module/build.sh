#!/bin/bash
# Build script for AWS Cognito Module

set -e

echo "Building AWS Cognito Module for Nakama..."

# Check if Go is installed
if ! command -v go &> /dev/null; then
    echo "Error: Go is not installed. Please install Go 1.25.0 or later."
    exit 1
fi

# Check Go version
GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
echo "Go version: ${GO_VERSION}"

# Download dependencies
echo "Downloading dependencies..."
go mod download

# Build the module
echo "Building plugin..."
go build -buildmode=plugin -trimpath -o cognito_module.so

# Check if build was successful
if [ -f cognito_module.so ]; then
    SIZE=$(du -h cognito_module.so | cut -f1)
    echo "✓ Build successful! Module size: ${SIZE}"
    echo ""
    echo "To use the module:"
    echo "  1. Copy cognito_module.so to your Nakama modules directory"
    echo "  2. Set environment variables (see .env.example)"
    echo "  3. Start Nakama with --runtime.path flag"
    echo ""
    echo "Example:"
    echo "  cp cognito_module.so /path/to/nakama/data/modules/"
    echo "  ./nakama --runtime.path /path/to/nakama/data/modules"
else
    echo "✗ Build failed!"
    exit 1
fi

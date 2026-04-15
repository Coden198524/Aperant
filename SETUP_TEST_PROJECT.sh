#!/bin/bash

# Setup Test Project for Parallel Execution Testing
# This script creates a new test project directory and initializes it

set -e

echo "================================"
echo "Parallel Execution Test Setup"
echo "================================"
echo ""

# Create test project directory
TEST_PROJECT_DIR="${HOME}/test-calculator-project"

echo "Creating test project at: $TEST_PROJECT_DIR"
mkdir -p "$TEST_PROJECT_DIR"
cd "$TEST_PROJECT_DIR"

# Initialize npm project
echo "Initializing npm project..."
npm init -y

# Add TypeScript dependencies
echo "Installing dependencies..."
npm install --save-dev typescript ts-node @types/node jest @types/jest ts-jest

# Create directory structure
echo "Creating directory structure..."
mkdir -p src/__tests__
mkdir -p src/calculator

# Create tsconfig.json
echo "Creating tsconfig.json..."
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "node"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
EOF

# Create jest.config.js
echo "Creating jest.config.js..."
cat > jest.config.js << 'EOF'
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
EOF

# Create package.json scripts
echo "Updating package.json scripts..."
npm set-script "build" "tsc"
npm set-script "start" "node dist/index.js"
npm set-script "dev" "ts-node src/index.ts"
npm set-script "test" "jest"

# Create placeholder files (so user knows what to implement)
echo "Creating placeholder files..."

cat > README.md << 'EOF'
# Calculator CLI Tool

A simple command-line calculator supporting basic arithmetic operations.

## Features
- Addition
- Subtraction
- Multiplication
- Division (with error handling)

## Usage

```bash
npm run dev add 5 3      # Result: 8
npm run dev subtract 10 3 # Result: 7
npm run dev multiply 6 7  # Result: 42
npm run dev divide 20 4   # Result: 5
```

## Testing

```bash
npm test
```

## Implementation Guide

This project is designed to be completed by AI agents in parallel batches.

### Expected Subtasks
1. Implement addition function
2. Implement subtraction function
3. Implement multiplication function
4. Implement division function with error handling
5. Create main CLI entry point
6. Add comprehensive test coverage
EOF

echo ""
echo "================================"
echo "✅ Test project created!"
echo "================================"
echo ""
echo "Project location: $TEST_PROJECT_DIR"
echo ""
echo "Next steps:"
echo "1. Open Auto Claude application"
echo "2. Create a new task with this description:"
echo ""
echo "   Title: Build a Simple CLI Calculator"
echo ""
echo "   Description:"
echo "   Create a command-line calculator with the following requirements:"
echo ""
echo "   1. Add addition function (add.ts) - supports two integers"
echo "   2. Add subtraction function (subtract.ts) - supports two integers"
echo "   3. Add multiplication function (multiply.ts) - supports two integers"
echo "   4. Add division function (divide.ts) - supports two integers with zero division handling"
echo "   5. Create main CLI entry (index.ts) - integrates all functions"
echo "   6. Add test coverage - comprehensive unit tests"
echo ""
echo "   Use the project at: $TEST_PROJECT_DIR"
echo ""
echo "3. Monitor the execution:"
echo "   - Watch for batch execution logs"
echo "   - Verify subtask count and batch numbers"
echo "   - Check the generated code in $TEST_PROJECT_DIR/src"
echo ""
echo "4. Verify the results:"
echo "   cd $TEST_PROJECT_DIR"
echo "   npm run build"
echo "   npm test"
echo "   npm run dev add 5 3"
echo ""

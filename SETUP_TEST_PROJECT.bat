@echo off
REM Setup Test Project for Parallel Execution Testing
REM This script creates a new test project directory and initializes it

setlocal enabledelayedexpansion

echo ================================
echo Parallel Execution Test Setup
echo ================================
echo.

REM Create test project directory
set TEST_PROJECT_DIR=%USERPROFILE%\test-calculator-project

echo Creating test project at: %TEST_PROJECT_DIR%
if not exist "%TEST_PROJECT_DIR%" mkdir "%TEST_PROJECT_DIR%"
cd /d "%TEST_PROJECT_DIR%"

REM Initialize npm project
echo Initializing npm project...
call npm init -y

REM Add TypeScript dependencies
echo Installing dependencies...
call npm install --save-dev typescript ts-node @types/node jest @types/jest ts-jest

REM Create directory structure
echo Creating directory structure...
if not exist "src" mkdir src
if not exist "src\__tests__" mkdir src\__tests__
if not exist "src\calculator" mkdir src\calculator

REM Create tsconfig.json
echo Creating tsconfig.json...
(
  echo {
  echo   "compilerOptions": {
  echo     "target": "ES2020",
  echo     "module": "commonjs",
  echo     "lib": ["ES2020"],
  echo     "outDir": "./dist",
  echo     "rootDir": "./src",
  echo     "strict": true,
  echo     "esModuleInterop": true,
  echo     "skipLibCheck": true,
  echo     "forceConsistentCasingInFileNames": true,
  echo     "resolveJsonModule": true,
  echo     "moduleResolution": "node"
  echo   },
  echo   "include": ["src"],
  echo   "exclude": ["node_modules", "dist"]
  echo }
) > tsconfig.json

REM Create jest.config.js
echo Creating jest.config.js...
(
  echo module.exports = {
  echo   preset: 'ts-jest',
  echo   testEnvironment: 'node',
  echo   testMatch: ['**/__tests__/**/*.test.ts'],
  echo   moduleFileExtensions: ['ts', 'js', 'json'],
  echo };
) > jest.config.js

REM Create package.json scripts
echo Updating package.json scripts...
call npm set-script "build" "tsc"
call npm set-script "start" "node dist/index.js"
call npm set-script "dev" "ts-node src/index.ts"
call npm set-script "test" "jest"

REM Create placeholder files
echo Creating placeholder files...

REM Create README.md
(
  echo # Calculator CLI Tool
  echo.
  echo A simple command-line calculator supporting basic arithmetic operations.
  echo.
  echo ## Features
  echo - Addition
  echo - Subtraction
  echo - Multiplication
  echo - Division (with error handling
  echo.
  echo ## Usage
  echo.
  echo ```bash
  echo npm run dev add 5 3      # Result: 8
  echo npm run dev subtract 10 3 # Result: 7
  echo npm run dev multiply 6 7  # Result: 42
  echo npm run dev divide 20 4   # Result: 5
  echo ```
  echo.
  echo ## Testing
  echo.
  echo ```bash
  echo npm test
  echo ```
  echo.
  echo ## Implementation Guide
  echo.
  echo This project is designed to be completed by AI agents in parallel batches.
  echo.
  echo ### Expected Subtasks
  echo 1. Implement addition function
  echo 2. Implement subtraction function
  echo 3. Implement multiplication function
  echo 4. Implement division function with error handling
  echo 5. Create main CLI entry point
  echo 6. Add comprehensive test coverage
) > README.md

echo.
echo ================================
echo Test project created!
echo ================================
echo.
echo Project location: %TEST_PROJECT_DIR%
echo.
echo Next steps:
echo 1. Open Autocode application
echo 2. Create a new task with this description:
echo.
echo    Title: Build a Simple CLI Calculator
echo.
echo    Description:
echo    Create a command-line calculator with the following requirements:
echo.
echo    1. Add addition function (add.ts) - supports two integers
echo    2. Add subtraction function (subtract.ts) - supports two integers
echo    3. Add multiplication function (multiply.ts) - supports two integers
echo    4. Add division function (divide.ts) - supports two integers with zero division handling
echo    5. Create main CLI entry (index.ts) - integrates all functions
echo    6. Add test coverage - comprehensive unit tests
echo.
echo    Use the project at: %TEST_PROJECT_DIR%
echo.
echo 3. Monitor the execution:
echo    - Watch for batch execution logs
echo    - Verify subtask count and batch numbers
echo    - Check the generated code in %TEST_PROJECT_DIR%\src
echo.
echo 4. Verify the results:
echo    cd %TEST_PROJECT_DIR%
echo    npm run build
echo    npm test
echo    npm run dev add 5 3
echo.

pause

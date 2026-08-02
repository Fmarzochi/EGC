const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = [
    {
        ignores: [
            '.opencode/dist/**',
            '.cursor/**',
            '.claude/**',
            'dashboard/**',
            'node_modules/**',
            'mcp/servers/*/build/**',
            'fuzz/validator.cjs'
        ]
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.es2022
            }
        },
        rules: {
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_'
            }],
            'no-undef': 'error',
            'eqeqeq': 'warn',
            'complexity': ['warn', { max: 20 }]
        }
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            sourceType: 'module'
        }
    },
    // mcp/servers/**/*.ts had zero ESLint coverage: no TS parser was
    // configured anywhere in the tree, and this file's default file
    // matching never selects .ts (engineering audit, EGC-538).
    ...tseslint.configs.recommended.map(config => ({
        ...config,
        files: ['mcp/servers/*/src/**/*.ts']
    })),
    {
        files: ['mcp/servers/*/src/**/*.ts'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2022
            }
        },
        rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_'
            }],
            'eqeqeq': 'warn',
            'complexity': ['warn', { max: 20 }]
        }
    }
];

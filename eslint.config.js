const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: [
            '.opencode/dist/**',
            '.cursor/**',
            '.claude/**',
            'dashboard/**',
            'node_modules/**',
            'mcp/servers/*/build/**'
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
    }
];

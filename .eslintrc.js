module.exports = {
    env: {
        node: true,
        es2021: true,
        jest: true
    },
    extends: ['eslint:recommended'],
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
    },
    rules: {
        'no-console': 'warn',  // Prefer logger over console
        'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        'no-var': 'error',  // Use const/let instead of var
        'prefer-const': 'error',
        'eqeqeq': ['error', 'always'],  // Use === instead of ==
        'curly': ['error', 'all'],  // Require curly braces
        'no-throw-literal': 'error',
        'prefer-promise-reject-errors': 'error',
        'no-return-await': 'error',
        'require-await': 'warn'
    }
};


# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 4.0.0-beta.14 - 2024-09-23

## 4.0.0-beta.13 - 2024-09-23

## 4.0.0-beta.12 - 2024-09-23

## 4.0.0-beta.11 - 2024-09-23
Lazy properties initialization for lambdas

## 4.0.0-beta.9 - 2024-09-22
Placeholder for test phase lambdas initialization

## 4.0.0-beta.8 - 2024-09-22
Lambda level initialization and cleanup

## 4.0.0-beta.7 - 2024-09-19
Insights layer made configurable

## 4.0.0-beta.4 - 2024-09-18
Insights layer added to lambda functions

## 4.0.0-beta.3 - 2024-09-18
Lambda teardown interception point added"

## 4.0.0-beta.2 - 2024-09-16
Database replica injection, inluding separate access to main and read replica

## 4.0.0-beta.0 - 2024-09-14
Merged with cdk-typescript-lib

## 3.2.0-beta.3 - 2024-08-27
Serverless database connection parameters configurable by environment variables

## 3.2.0-beta.2 - 2024-08-24
Serverless database connection parameters (hard-coded for now)

## 3.2.0-beta.1 - 2024-08-24
Added application name for serverless DB connection

## 3.2.0-beta.0 - 2024-08-24
Postgress connection moved to `serverless-postgres` instead of `pg`

## 3.1.1 - 2024-07-25
Order of teardown handlers fixed

## 3.1.0 - 2024-07-21
Telegraf connector automatically calling handleUpdate

## 3.1.0-beta.0 - 2024-07-21

## 3.0.0 - 2024-06-21
Features introduced in the beta version stabilised and documented

## 3.0.0-beta.4 - 2024-06-21
Better types compatibility for primitive types in `typedQuery`

## 3.0.0-beta.3 - 2024-06-18
Handler prop event exceptionally accepts undefined value

## 3.0.0-beta.2 - 2024-06-17
### Added
- Telegraf connector

## 3.0.0-beta.1 - 2024-06-17
AWS secrets connector simplified

### Added
- Source event injection into the AWS lambda

## 3.0.0-beta.0 - 2024-06-16
AWS secrets connector added

### Removed
- Deprecated `handlerImpl` and `connectedHandlerImpl`

## 2.2.1 - 2024-05-27
Optional links added to push notifications

## 2.2.0 - 2024-05-27

## 2.1.2 - 2024-05-11
Dependencies updated

## 2.1.1 - 2024-04-29
Dictionary schemas integrated

## 2.1.0 - 2024-04-25
Primitive types now accepted by `typedQuery`

### Added
- Stable version of Firebase admin connectivity

### Changed
- `handlerImpl` and `connectedHandlerImpl` are now deprecated. They are replaced by a more flexible `connectLambda`

## 2.1.0-beta.0 - 2024-04-22

## 2.0.0-beta.2 - 2024-04-15

## 2.0.0-beta.1 - 2024-04-15
### Added
- Shortcut parameters for `lambdaConnector`

## 2.0.0-beta.0 - 2024-04-14
Firebase admin connection support

## 1.6.0-beta.0 - 2024-04-14
Replacing handlerImpl and connectedHandlerImpl by lambdaConnector

## 1.5.0 - 2024-04-09
Security context added for handlers through the optional `authenticator` parameter

## 1.5.0-beta.1 - 2024-04-09

## 1.5.0-beta.0 - 2024-04-09

## 1.4.0 - 2024-04-02
"FUNCTION" action for inserted fields

## 1.3.0 - 2024-03-28
Migrated to Typescript 5.4

## 1.2.1 - 2024-03-27
Counter actions for number fields

## 1.2.0 - 2024-03-27

## 1.1.0 - 2024-03-25
Optional `errorHandler` parameter for `handlerImpl` and `connectedHandlerImpl`

## 1.1.0-beta.1 - 2024-03-23

## 1.1.0-beta.0 - 2024-03-23
Custom error handlers for handler implementations

## 1.0.2 - 2024-03-17
Dependencies updated

## 1.0.1 - 2024-03-13
Documented and released

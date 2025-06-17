#!/bin/bash

tsc --build --clean && jest $1 --runInBand && npx coverage-badges

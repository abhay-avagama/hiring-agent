import { expect, test } from "bun:test";
import { classifyJob } from "../src/locations.ts";
import type { Job } from "../src/types.ts";

const job = (location: string, description = ""): Job => ({
  id: "greenhouse:acme:1", company: "Acme", title: "Engineer", location, remote: false, workMode: "unknown",
  eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown", url: "https://example.test/1", description,
});

test("country codes are current ISO countries only, with UK folded into GB", () => {
  expect(classifyJob(job("Freiburg, Germany")).eligibleCountries).toEqual(["DE"]);
  expect(classifyJob(job("London, UK")).eligibleCountries).toEqual(["GB"]);
  expect(classifyJob(job("UK - London")).eligibleCountries).toEqual(["GB"]);
  expect(classifyJob(job("United Kingdom - London")).eligibleCountries).toEqual(["GB"]);
  expect(classifyJob(job("Bengaluru, India")).eligibleCountries).toEqual(["IN"]);
  expect(classifyJob(job("Remote - US")).eligibleCountries).toEqual(["US"]);
});

test("US state codes in City, ST locations are states, not countries", () => {
  expect(classifyJob(job("INDIANAPOLIS, IN")).eligibleCountries).toEqual(["US"]);
  expect(classifyJob(job("Gary, IN")).eligibleCountries).toEqual(["US"]);
  expect(classifyJob(job("San Francisco, CA")).eligibleCountries).toEqual(["US"]);
  expect(classifyJob(job("Wilmington, DE 19801")).eligibleCountries).toEqual(["US"]);
  expect(classifyJob(job("Denver, CO, United States")).eligibleCountries).toEqual(["US"]);
  expect(classifyJob(job("Bengaluru, IN")).eligibleCountries).toEqual(["IN"]);
  expect(classifyJob(job("Pune, Maharashtra, IN")).eligibleCountries).toEqual(["IN"]);
  expect(classifyJob(job("Berlin, Germany")).eligibleCountries).toEqual(["DE"]);
  expect(classifyJob(job("Toronto, ON, Canada")).eligibleCountries).toEqual(["CA"]);
  expect(classifyJob(job("Remote - IN")).eligibleCountries).toEqual(["IN"]);
  expect(classifyJob(job("IN-INDIANAPOLIS, 220 VIRGINIA AVE")).eligibleCountries).toEqual(["US"]);
  expect(classifyJob(job("CA-Los Angeles")).eligibleCountries).toEqual(["US"]);
  expect(classifyJob(job("IN-Bengaluru")).eligibleCountries).toEqual(["IN"]);
  expect(classifyJob(job("IN - Indianapolis")).eligibleCountries).toEqual(["US"]);
  expect(classifyJob(job("IN - Pune")).eligibleCountries).toEqual(["IN"]);
  expect(classifyJob(job("IN-Maharashtra-Pune-7th-Floor")).eligibleCountries).toEqual(["IN"]);
});

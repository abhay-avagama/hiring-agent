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

test("Indian state codes beside a named India are states, not countries", () => {
  for (const location of ["Hyderabad, TG, India", "Bengaluru, KA, India", "Mumbai, MH, India", "Panaji, GA, India"]) {
    expect(classifyJob(job(location)).eligibleCountries).toEqual(["IN"]);
  }
  expect(classifyJob(job("Lomé, TG")).eligibleCountries).toEqual(["TG"]);
});

test("Workday's US-STATE-CITY shape is the United States, not India", () => {
  // "US-IN-FT WAYNE" is Fort Wayne, Indiana. The leading "US" was read as the state code, which is not one, so
  // the state was never seen and a bare "IN" further along the string filed the role under India.
  for (const location of ["US-IN-FT WAYNE-150A ~ 1010 Production Rd ~ BLDG 150A", "US-IN-Crane",
                          "US-IN-Fort Wayne", "US - CA - San Jose", "US-DE-Wilmington", "US-GA-Atlanta"]) {
    const countries = classifyJob(job(location)).eligibleCountries;
    expect(countries).toContain("US");
    expect(countries).not.toContain("IN");
  }
});

test("genuinely Indian locations are still India", () => {
  for (const location of ["Bengaluru, Karnataka, India", "Hyderabad, TG, India", "Pune, Mahārāshtra, IN",
                          "IN - Bangalore", "Noida, UP, IN", "Chennai, IN"]) {
    expect(classifyJob(job(location)).eligibleCountries).toContain("IN");
  }
});

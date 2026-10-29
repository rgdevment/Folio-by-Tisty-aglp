use std::net::{Ipv4Addr, Ipv6Addr};

use super::*;

const SECRET: [u8; 32] = [5; 32];
const T0: i64 = 1_800_000_000;

fn four(last: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(192, 0, 2, last))
}

#[test]
fn a_caller_has_another_name_every_day_and_on_every_server() {
    let today_here = today(&SECRET, four(1), T0);
    assert_eq!(today_here, today(&SECRET, four(1), T0 + 60));
    assert_ne!(today_here, today(&SECRET, four(1), T0 + DAY));
    assert_ne!(today_here, today(&[6; 32], four(1), T0));
    assert_ne!(today_here, today(&SECRET, four(2), T0));
    assert!(
        !today_here.contains("192"),
        "the address itself never shows"
    );
}

#[test]
fn the_lasting_name_holds_across_days_and_differs_from_today_s() {
    let period = 90 * DAY;
    let start = T0.div_euclid(period) * period;
    let lasting_here = lasting(&SECRET, four(1), start, period);
    assert_eq!(
        lasting_here,
        lasting(&SECRET, four(1), start + period - 1, period)
    );
    assert_ne!(lasting_here, today(&SECRET, four(1), start));
}

#[test]
fn the_lasting_name_changes_once_its_period_is_over() {
    let period = 90 * DAY;
    let start = T0.div_euclid(period) * period;
    assert_ne!(
        lasting(&SECRET, four(1), start, period),
        lasting(&SECRET, four(1), start + period, period)
    );
}

#[test]
fn an_ipv6_caller_is_its_slash_64_and_a_mapped_ipv4_is_its_ipv4() {
    let a = IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 7, 7, 1, 2, 3, 4));
    let b = IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 7, 7, 9, 9, 9, 9));
    assert_eq!(today(&SECRET, a, T0), today(&SECRET, b, T0));
    let mapped = IpAddr::V6(Ipv4Addr::new(192, 0, 2, 1).to_ipv6_mapped());
    assert_eq!(today(&SECRET, mapped, T0), today(&SECRET, four(1), T0));
}

#[test]
fn an_upload_costs_more_bits_the_more_megabytes_it_carries() {
    let work = Work::default();
    assert_eq!(work.for_upload(0), work.upload);
    assert_eq!(work.for_upload(1), work.upload + work.per_megabyte);
    assert_eq!(
        work.for_upload(2 * 1024 * 1024 + 1),
        work.upload + 3 * work.per_megabyte
    );
    assert_eq!(work.for_upload(u64::MAX), work::BITS_AT_MOST);
}

#[test]
fn a_challenge_answers_only_for_what_it_was_bound_to_and_only_until_it_expires() {
    let asked = challenge(&SECRET, b"reserve", [1; 16], 4, T0 + 600);
    let proof = work::solve(&asked).unwrap();

    assert_eq!(checked(&SECRET, b"reserve", &proof, 4, T0 + 599), Ok(()));
    assert_eq!(
        checked(&SECRET, b"report:x", &proof, 4, T0),
        Err(Refused::WorkRefused)
    );
    assert_eq!(
        checked(&SECRET, b"reserve", &proof, 5, T0),
        Err(Refused::WorkRefused)
    );
    assert_eq!(
        checked(&SECRET, b"reserve", &proof, 4, T0 + 601),
        Err(Refused::WorkRefused)
    );

    let mut cheaper = proof.clone();
    cheaper.challenge.bits = 0;
    assert_eq!(
        checked(&SECRET, b"reserve", &cheaper, 0, T0),
        Err(Refused::WorkRefused)
    );
}

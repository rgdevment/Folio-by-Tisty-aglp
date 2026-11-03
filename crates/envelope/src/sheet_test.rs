use super::*;

fn split(envelope: &Envelope) -> (Envelope, Vec<u8>) {
    let bytes = envelope.to_bytes();
    let end = envelope.sheet_end().expect("pictures follow the page") as usize;
    let sheet = Envelope::read_sheet(bytes[..end].to_vec(), &Limits::default()).unwrap();
    (sheet, bytes[end..].to_vec())
}

fn shown(pictures: &[(Kind, Zeroizing<Vec<u8>>)]) -> Vec<(Kind, Vec<u8>)> {
    pictures
        .iter()
        .map(|(kind, bytes)| (*kind, bytes.to_vec()))
        .collect()
}

#[test]
fn a_sheet_and_then_its_rest_open_to_what_the_whole_envelope_does() {
    let mario = machine(1);
    let (one, two) = (png(1, 300), jpeg(200));
    let pictures = [(Kind::Png, one.as_slice()), (Kind::Jpeg, two.as_slice())];
    let list = [cited("notas", "nts9Qe", None)];
    let page = Draft {
        cited: &list,
        ..drawn("# Plan\n\nHola.", "<p>hola</p>", &pictures)
    };
    for by in [None, Some(mario.signer())] {
        let sealed = sealed(&key(9), &page, by.as_ref()).unwrap();
        let whole = open(&key(9), &read(&sealed.to_bytes()).unwrap(), &[]).unwrap();

        let (mut begun, rest) = split(&sealed);
        let sheet = open_sheet(&key(9), &begun, &[]).unwrap();
        assert_eq!(sheet.manifest, whole.manifest);
        assert_eq!(
            (&sheet.cited, sheet.html.as_str()),
            (&whole.cited, whole.html.as_str())
        );
        assert_eq!(sheet.config, whole.config);
        assert_eq!((sheet.wrote, sheet.sent), (whole.wrote, whole.sent));
        assert_eq!(sheet.written, whole.written);

        begun.rest(rest).unwrap();
        assert_eq!(begun, read(&sealed.to_bytes()).unwrap());
        let arrived = open_rest(&key(9), &begun, &sheet).unwrap();
        assert_eq!(shown(&arrived.pictures), shown(&whole.pictures));
        assert_eq!(arrived.text.as_str(), whole.text.as_str());
    }
}

#[test]
fn a_picture_or_the_words_changed_in_the_rest_are_refused_while_the_sheet_holds() {
    let mario = machine(1);
    let (honest, other) = (png(1, 300), png(2, 300));
    let written = [(Kind::Png, honest.as_slice())];
    let swapped = [(Kind::Png, other.as_slice())];
    let html = "<p>hola</p>";
    for carried in [
        drawn("hola", html, &swapped),
        drawn("adiós", html, &written),
    ] {
        let sealed = resealed(&drawn("hola", html, &written), &carried, &mario);
        let (mut begun, rest) = split(&sealed);
        let sheet = open_sheet(&key(9), &begun, &[]).unwrap();
        assert!(holds_for(sheet.wrote, &mario));
        begun.rest(rest).unwrap();
        assert_eq!(
            open_rest(&key(9), &begun, &sheet).err(),
            Some(Refused::Damaged)
        );
        let opened = open(&key(9), &begun, &[]).unwrap();
        assert_eq!(opened.wrote, Some(Verdict::Refused));
    }
}

#[test]
fn a_sheet_is_read_only_when_it_ends_where_its_page_does() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let sealed = sealed(&key(9), &drawn("hola", "<p>hola</p>", &pictures), None).unwrap();
    let bytes = sealed.to_bytes();
    let end = sealed.sheet_end().unwrap() as usize;
    let sheet = |bytes: &[u8]| Envelope::read_sheet(bytes.to_vec(), &Limits::default()).err();

    assert_eq!(sheet(&bytes[..end]), None);
    let first_part = sealed.parts[0].start;
    for cut in [first_part, end - 1, end + 1, bytes.len()] {
        assert_eq!(sheet(&bytes[..cut]), Some(Refused::Damaged), "cut at {cut}");
    }
    for at in (first_part..end).step_by(5) {
        let mut changed = bytes[..end].to_vec();
        changed[at] ^= 1;
        assert_eq!(sheet(&changed), Some(Refused::Damaged), "byte {at}");
    }
}

#[test]
fn the_rest_is_taken_only_as_the_index_hashes_it_up_to_the_last_byte() {
    let picture = png(1, 300);
    let pictures = [(Kind::Png, picture.as_slice())];
    let sealed = sealed(&key(9), &drawn("hola", "<p>hola</p>", &pictures), None).unwrap();
    let (mut begun, rest) = split(&sealed);
    let sheet = open_sheet(&key(9), &begun, &[]).unwrap();
    assert_eq!(
        open_rest(&key(9), &begun, &sheet).err(),
        Some(Refused::Damaged)
    );
    assert_eq!(open(&key(9), &begun, &[]).err(), Some(Refused::Damaged));

    let mut longer = rest.clone();
    longer.push(0);
    let mut changed = rest.clone();
    changed[rest.len() / 2] ^= 1;
    for wrong in [rest[..rest.len() - 1].to_vec(), longer, changed, Vec::new()] {
        assert_eq!(begun.rest(wrong).err(), Some(Refused::Damaged));
    }
    begun.rest(rest.clone()).unwrap();
    assert!(open_rest(&key(9), &begun, &sheet).is_ok());
    assert_eq!(begun.rest(rest).err(), Some(Refused::Damaged));
}

#[test]
fn an_envelope_without_pictures_is_never_read_apart() {
    let sealed = sealed(&key(9), &drawn("hola", "<p>hola</p>", &[]), None).unwrap();
    assert_eq!(sealed.sheet_end(), None);
    assert_eq!(read(&sealed.to_bytes()).unwrap().sheet_end(), None);
}
